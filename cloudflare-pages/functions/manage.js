// Cloudflare Pages Function —— 文章管理（分类/文件夹 + 排序）
// 路由: POST /manage
// 鉴权: 请求体里的 key 必须等于环境变量 ADMIN_KEY（服务端校验，前端拿不到真值）
//
// 支持的动作（action）:
//   verify          仅校验口令，用于「验证界面」
//   list            列出全部文章（含 front-matter 解析结果）
//   setCategory     把某篇文章移动到指定分类（"技术/前端" 表示层级）
//   renameCategory  重命名分类（含其后代分类）
//   deleteCategory  删除分类（从所属文章上摘掉）
//   reorder         按给定顺序重排（重写 date，并用 permalink 保住旧链接）
//   setDate         单篇修改发布日期（同样保住旧链接）
//
// 设计要点:
//   1. 不依赖任何 npm 包（Pages Functions 直接跑，无需构建）。front-matter 用
//      行级解析，只改我们关心的字段，其余字段（title/cover/tags/description…）
//      原样保留，格式与注释都不丢。
//   2. `_config.yml` 里 permalink 是 `:year/:month/:day/:title/`，日期会进 URL。
//      所以「改日期」时必须同时写死 `permalink`，否则旧链接全废。已带 permalink
//      的文章不再覆盖，保证幂等。
//   3. 文章主题（firefly）的置顶字段是 `pinned` / `sticky`，只影响角标、不影响排序；
//      顺序完全由 date 决定（index_generator.order_by: -date）。

const DEF_REPO = "Entropyqwe/hexo-firefly-site";
const DEF_BRANCH = "main";
const POSTS_DIR = "source/_posts";

// ---------------------------------------------------------------- 基础工具

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

function ghHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "entropy-post-manager",
    "Content-Type": "application/json",
  };
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const repoOf = (env) => env.REPO || DEF_REPO;
const branchOf = (env) => env.BRANCH || DEF_BRANCH;
const apiBase = (env, p) =>
  `https://api.github.com/repos/${repoOf(env)}/contents/${p}?ref=${branchOf(env)}`;

// ---------------------------------------------------------------- GitHub 读写

async function ghGetFile(env, path) {
  const r = await fetch(apiBase(env, path.split("/").map(encodeURIComponent).join("/")), {
    headers: ghHeaders(env.GITHUB_TOKEN),
  });
  if (!r.ok) return null;
  return r.json();
}

async function ghListDir(env, dir) {
  const r = await fetch(apiBase(env, dir.split("/").map(encodeURIComponent).join("/")), {
    headers: ghHeaders(env.GITHUB_TOKEN),
  });
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

async function ghPutFile(env, path, text, message, sha) {
  const body = { message, content: toB64(text), branch: branchOf(env) };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${repoOf(env)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "PUT", headers: ghHeaders(env.GITHUB_TOKEN), body: JSON.stringify(body) }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`写入 ${path} 失败（${r.status}）${t.slice(0, 160)}`);
  }
  return r.json();
}

// ---------------------------------------------------------------- front-matter

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFM(text) {
  const m = FM_RE.exec(text);
  if (!m) return { fields: [], body: text, hasFM: false };
  return { fields: parseFields(m[1]), body: text.slice(m[0].length), hasFM: true };
}

// 行级解析：顶层键为 ^key:，其余行（缩进续行）归到上一个键
function parseFields(fm) {
  const out = [];
  for (const line of fm.split(/\r?\n/)) {
    const km = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (km) out.push({ key: km[1], lines: [line] });
    else if (out.length) out[out.length - 1].lines.push(line);
    else out.push({ key: null, lines: [line] });
  }
  return out;
}

function getRaw(fields, key) {
  const f = fields.find((x) => x.key === key);
  if (!f) return null;
  const line = f.lines[0];
  return line.slice(line.indexOf(":") + 1).trim();
}

function setRaw(fields, key, value) {
  const f = fields.find((x) => x.key === key);
  const line = `${key}: ${value}`;
  if (f) f.lines = [line];
  else fields.push({ key, lines: [line] });
}

function dropKey(fields, key) {
  const i = fields.findIndex((x) => x.key === key);
  if (i >= 0) fields.splice(i, 1);
}

function buildFM(fields, body) {
  return "---\n" + fields.map((f) => f.lines.join("\n")).join("\n") + "\n---\n" + body;
}

// YAML 标量：简单值不加引号，否则单引号包裹（内部单引号翻倍转义）
function yScalar(s) {
  const v = String(s);
  // YAML 纯标量：首字符不能是 YAML 指示符（- ? : , [ ] { } # & * ! | > ' " % @ `），
  // 这里只放行字母/数字/汉字以及空格 . _ + - / ，其余一律单引号包裹。
  // 放行 / 是为了让 permalink 写成 `permalink: /2026/09/06/x/` 这种自然形式
  // （YAML 纯标量允许以 / 开头；危险的是 - ? : , [ ] { } # & * ! | > ' " % @ ` 这些指示符）
  if (/^[A-Za-z0-9\u4e00-\u9fff\/][A-Za-z0-9\u4e00-\u9fff ._+\-/]*$/.test(v)) return v;
  return "'" + v.replace(/'/g, "''") + "'";
}
const yList = (arr) => "[" + arr.map(yScalar).join(", ") + "]";

function parseListRaw(raw) {
  if (raw == null) return [];
  let s = String(raw).trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.trim()) return [];
  return s
    .split(",")
    .map((x) => x.trim().replace(/^['"]|['"]$/g, "").replace(/''/g, "'"))
    .filter(Boolean);
}

// ---------------------------------------------------------------- 日期

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/^['"]|['"]$/g, "").trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
}
const p2 = (n) => String(n).padStart(2, "0");
const fmtDate = (t) => `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}`;
const dateVal = (t) => Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
const fromVal = (v) => {
  const d = new Date(v);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
};

const slugOf = (path) => path.split("/").pop().replace(/\.md$/i, "");
// 与 _config.yml 的 permalink: :year/:month/:day/:title/ 对齐
const permalinkFrom = (t, slug) => `/${t.y}/${p2(t.mo)}/${p2(t.d)}/${slug}/`;

// ---------------------------------------------------------------- 文章解析

function parsePost(path, sha, text) {
  const { fields, body } = splitFM(text);
  const dm = getRaw(fields, "date");
  const dt = parseDate(dm);
  const cats = parseListRaw(getRaw(fields, "categories"));
  return {
    path,
    sha,
    file: path.split("/").pop(),
    slug: slugOf(path),
    title: parseListRaw(getRaw(fields, "title"))[0] || getRaw(fields, "title") || slugOf(path),
    dateRaw: dm,
    date: dt ? fmtDate(dt) : null,
    dateVal: dt ? dateVal(dt) : 0,
    categories: cats,
    categoryPath: cats.join("/"),
    tags: parseListRaw(getRaw(fields, "tags")),
    permalink: getRaw(fields, "permalink"),
    url: (getRaw(fields, "permalink") || (dt ? permalinkFrom(dt, slugOf(path)) : "/")),
    pinned: /^(true|1|yes)$/i.test(String(getRaw(fields, "pinned") || getRaw(fields, "sticky") || "").trim()),
    _text: text,
  };
}

async function loadAllPosts(env) {
  const entries = await ghListDir(env, POSTS_DIR);
  const files = entries.filter((e) => e.type === "file" && /\.md$/i.test(e.name));
  const posts = [];
  for (const e of files) {
    const f = await ghGetFile(env, e.path);
    if (!f || !f.content) continue;
    posts.push(parsePost(e.path, f.sha, fromB64(f.content)));
  }
  return posts;
}

// 依次写入，收集每一步结果；失败不中断（返回明细给前端）
async function commitAll(env, jobs, message) {
  const results = [];
  for (const j of jobs) {
    try {
      await ghPutFile(env, j.path, j.text, j.message || message, j.sha);
      results.push({ path: j.path, ok: true });
    } catch (err) {
      results.push({ path: j.path, ok: false, error: String(err.message || err) });
    }
  }
  return results;
}

// 改日期前先固化 permalink，避免 URL 随日期变化而失效（已有 permalink 则不动）
function protectPermalink(fields, oldDate, slug) {
  if (getRaw(fields, "permalink")) return false;
  if (!oldDate) return false;
  setRaw(fields, "permalink", yScalar(permalinkFrom(oldDate, slug)));
  return true;
}

// ---------------------------------------------------------------- 主入口

export async function onRequestPost(context) {
  const env = context.env;
  let p;
  try {
    p = await context.request.json();
  } catch (e) {
    return json(400, { ok: false, error: "请求体不是合法 JSON" });
  }
  const { key, action } = p || {};

  if (!env.ADMIN_KEY) return json(500, { ok: false, error: "服务端未配置 ADMIN_KEY" });
  if (!key || key !== env.ADMIN_KEY) return json(403, { ok: false, error: "密钥不正确，无权修改" });
  if (!env.GITHUB_TOKEN) return json(500, { ok: false, error: "服务端未配置 GITHUB_TOKEN" });

  try {
    switch (action) {
      case "verify":
        return json(200, { ok: true, note: "身份验证通过" });

      case "list": {
        const posts = await loadAllPosts(env);
        posts.sort((a, b) => b.dateVal - a.dateVal);
        const cats = {};
        posts.forEach((x) => {
          const path = x.categoryPath;
          if (!path) return;
          const seg = path.split("/");
          for (let i = 1; i <= seg.length; i++) {
            const k = seg.slice(0, i).join("/");
            cats[k] = (cats[k] || 0) + 1;
          }
        });
        return json(200, {
          ok: true,
          dir: POSTS_DIR,
          permalinkPattern: "/:year/:month/:day/:title/",
          posts: posts.map(({ _text, ...rest }) => rest),
          categories: Object.keys(cats)
            .sort()
            .map((k) => ({ path: k, count: cats[k], depth: k.split("/").length - 1 })),
        });
      }

      case "setCategory": {
        const { path, categories } = p;
        if (!path || !path.startsWith(POSTS_DIR + "/")) return json(400, { ok: false, error: "path 不合法" });
        const raw = String(categories || "").trim();
        const list = raw
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean);
        const f = await ghGetFile(env, path);
        if (!f) return json(404, { ok: false, error: "文章不存在" });
        const { fields, body } = splitFM(fromB64(f.content));
        if (list.length) setRaw(fields, "categories", yList(list));
        else dropKey(fields, "categories");
        await ghPutFile(env, path, buildFM(fields, body), `📁 调整分类: ${slugOf(path)} → ${list.join("/") || "未分类"}`, f.sha);
        return json(200, { ok: true, note: `已移动到「${list.join("/") || "未分类"}」，1~3 分钟上线` });
      }

      case "renameCategory": {
        const { from, to } = p;
        if (!from || !to) return json(400, { ok: false, error: "需要 from 与 to" });
        const fromSeg = String(from).split("/").filter(Boolean);
        const toSeg = String(to).split("/").filter(Boolean);
        const posts = await loadAllPosts(env);
        const jobs = [];
        for (const post of posts) {
          const seg = post.categories;
          // 命中自身或其后代
          let hit = true;
          for (let i = 0; i < fromSeg.length; i++) if (seg[i] !== fromSeg[i]) { hit = false; break; }
          if (!hit) continue;
          const next = toSeg.concat(seg.slice(fromSeg.length));
          const { fields, body } = splitFM(post._text);
          setRaw(fields, "categories", yList(next));
          jobs.push({ path: post.path, sha: post.sha, text: buildFM(fields, body), message: `📁 分类重命名: ${from} → ${to}` });
        }
        if (!jobs.length) return json(200, { ok: true, changed: 0, note: "没有文章使用该分类" });
        const results = await commitAll(env, jobs, `📁 分类重命名: ${from} → ${to}`);
        const bad = results.filter((r) => !r.ok);
        return json(200, { ok: bad.length === 0, changed: results.length - bad.length, failed: bad, note: `已更新 ${results.length - bad.length} 篇文章` });
      }

      case "deleteCategory": {
        const { name, moveTo } = p;
        if (!name) return json(400, { ok: false, error: "需要 name" });
        const target = String(moveTo || "").trim();
        const posts = await loadAllPosts(env);
        const jobs = [];
        for (const post of posts) {
          if (post.categoryPath !== String(name)) continue;
          const { fields, body } = splitFM(post._text);
          if (target) setRaw(fields, "categories", yList(target.split("/").filter(Boolean)));
          else dropKey(fields, "categories");
          jobs.push({ path: post.path, sha: post.sha, text: buildFM(fields, body), message: `🗂 删除分类 ${name}` });
        }
        if (!jobs.length) return json(200, { ok: true, changed: 0, note: "没有文章使用该分类" });
        const results = await commitAll(env, jobs, `🗂 删除分类 ${name}`);
        const bad = results.filter((r) => !r.ok);
        return json(200, { ok: bad.length === 0, changed: results.length - bad.length, failed: bad, note: `已处理 ${results.length - bad.length} 篇文章` });
      }

      case "setDate": {
        const { path, date } = p;
        if (!path || !path.startsWith(POSTS_DIR + "/")) return json(400, { ok: false, error: "path 不合法" });
        const nd = parseDate(date);
        if (!nd) return json(400, { ok: false, error: "日期格式应为 YYYY-MM-DD HH:mm" });
        const f = await ghGetFile(env, path);
        if (!f) return json(404, { ok: false, error: "文章不存在" });
        const { fields, body } = splitFM(fromB64(f.content));
        const old = parseDate(getRaw(fields, "date"));
        const kept = protectPermalink(fields, old, slugOf(path));
        setRaw(fields, "date", fmtDate(nd));
        await ghPutFile(env, path, buildFM(fields, body), `🕒 调整发布时间: ${slugOf(path)}`, f.sha);
        return json(200, {
          ok: true,
          permalinkProtected: kept,
          note: `已改为 ${fmtDate(nd)}${kept ? "（旧链接已用 permalink 固定，不会失效）" : ""}`,
        });
      }

      case "reorder": {
        // order: [{path}, ...] 期望显示顺序（前 → 后）
        const order = Array.isArray(p.order) ? p.order : [];
        if (!order.length) return json(400, { ok: false, error: "order 为空" });
        const posts = await loadAllPosts(env);
        const byPath = new Map(posts.map((x) => [x.path, x]));
        const picked = [];
        for (const o of order) {
          const post = byPath.get(o.path);
          if (post) picked.push(post);
        }
        if (picked.length !== order.length) return json(400, { ok: false, error: "order 里含未知文章" });

        // 取现有日期集合（降序），按新顺序逐个回填 —— 不凭空造日期，日期集合保持不变
        const pool = posts.map((x) => x.dateVal || 0).sort((a, b) => b - a);
        let prev = null;
        const jobs = [];
        picked.forEach((post, i) => {
          let v = pool[i] != null ? pool[i] : (prev != null ? prev - 60000 : Date.now());
          if (prev != null && v >= prev) v = prev - 1000; // 同秒兜底，保证严格降序
          prev = v;
          const nd = fromVal(v);
          const line = fmtDate(nd);
          if (line === post.dateRaw) return;
          const { fields, body } = splitFM(post._text);
          protectPermalink(fields, parseDate(post.dateRaw), post.slug);
          setRaw(fields, "date", line);
          jobs.push({ path: post.path, sha: post.sha, text: buildFM(fields, body), message: `🔀 调整顺序: ${post.slug}` });
        });
        if (!jobs.length) return json(200, { ok: true, changed: 0, note: "顺序已是目标顺序" });
        const results = await commitAll(env, jobs, "🔀 调整文章顺序");
        const bad = results.filter((r) => !r.ok);
        return json(200, { ok: bad.length === 0, changed: results.length - bad.length, failed: bad, note: `已重排 ${results.length - bad.length} 篇文章，1~3 分钟上线` });
      }

      default:
        return json(400, { ok: false, error: "未知 action: " + action });
    }
  } catch (err) {
    return json(502, { ok: false, error: "服务端错误", detail: String((err && err.message) || err).slice(0, 300) });
  }
}

// 纯函数导出，供本地单元测试使用。
// Cloudflare Pages Functions 只识别 onRequest* 导出，额外导出不会有副作用。
export const __test = {
  splitFM, parseFields, getRaw, setRaw, dropKey, buildFM,
  parseDate, fmtDate, permalinkFrom, parseListRaw, parsePost,
  yScalar, yList, protectPermalink,
};
