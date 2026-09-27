// 后端集成测试：mock GitHub API，走完整的 onRequestPost 链路
// 运行: node test/manage.integration.test.mjs /path/to/hexo-site/source/_posts
//
// 覆盖：鉴权、list 分类聚合、setCategory、setDate（护链接）、reorder（重排 + 护链接）

import fs from 'node:fs';
import path from 'node:path';
import { onRequestPost } from '../cloudflare-pages/functions/manage.js';

const DIR = process.argv[2];
if (!DIR || !fs.existsSync(DIR)) { console.error('用法: node test/manage.integration.test.mjs <source/_posts>'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x ? '  → ' + x : ''}`); } };

// ---------------------------------------------------------------- mock GitHub
const files = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.md'))) {
  files['source/_posts/' + f] = fs.readFileSync(path.join(DIR, f), 'utf8');
}
let counter = 0;
const shaOf = (p) => 'sha' + (++counter).toString(36);
const puts = [];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(u.pathname);
  if (!m) return new Response('not found', { status: 404 });
  const rel = decodeURIComponent(m[3]);

  if (init.method === 'PUT') {
    const body = JSON.parse(init.body);
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    puts.push({ path: rel, message: body.message, text, sha: body.sha });
    files[rel] = text;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (rel === 'source/_posts') {
    return new Response(JSON.stringify(Object.keys(files).map((p) => ({ type: 'file', name: p.split('/').pop(), path: p }))), { status: 200 });
  }
  if (files[rel] != null) {
    return new Response(JSON.stringify({ content: Buffer.from(files[rel], 'utf8').toString('base64'), sha: 'sha:' + rel }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

// ---------------------------------------------------------------- 调用工具
const ENV = { ADMIN_KEY: 'TESTKEY', GITHUB_TOKEN: 'ghp_fake', REPO: 'o/r', BRANCH: 'main' };
async function call(body, env = ENV) {
  const req = new Request('https://x/manage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await onRequestPost({ request: req, env });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- 测试
console.log('\n【鉴权】');
{
  let r = await call({ key: 'wrong', action: 'list' });
  ok('错误密钥 → 403', r.status === 403 && !r.body.ok, JSON.stringify(r.body));
  r = await call({ key: 'TESTKEY', action: 'verify' });
  ok('正确密钥 → verify 通过', r.status === 200 && r.body.ok);
  r = await call({ key: 'TESTKEY', action: '不存在的动作' });
  ok('未知 action → 400', r.status === 400, JSON.stringify(r.body));
}

console.log('\n【list】');
let list;
{
  const r = await call({ key: 'TESTKEY', action: 'list' });
  list = r.body;
  ok('返回全部文章', r.body.posts.length === 6, String(r.body.posts.length));
  ok('按日期倒序', r.body.posts[0].date > r.body.posts[5].date);
  const cats = r.body.categories.map((c) => c.path + '×' + c.count);
  console.log('     分类统计:', cats.join(', '));
  ok('分类聚合正确（随笔 5 / 硬件 1）',
    r.body.categories.some((c) => c.path === '随笔' && c.count === 5) &&
    r.body.categories.some((c) => c.path === '硬件' && c.count === 1));
  ok('url 字段与线上一致', r.body.posts.find((p) => p.slug === 'kirin9020-scan').url === '/2026/09/06/kirin9020-scan/');
}

console.log('\n【setCategory：移动到两级分类】');
{
  puts.length = 0;
  const p = list.posts.find((x) => x.slug === 'kirin9020-scan');
  const r = await call({ key: 'TESTKEY', action: 'setCategory', path: p.path, categories: '技术/硬件' });
  ok('接口返回成功', r.body.ok, JSON.stringify(r.body));
  ok('只产生 1 次提交', puts.length === 1, String(puts.length));
  const out = puts[0].text;
  ok('categories 写成两级', out.includes('categories: [技术, 硬件]'), out.match(/categories:.*/)?.[0]);
  ok('title/tags/cover/description 未丢失',
    out.includes('title: 麒麟9020扫描图') && out.includes('tags: [麒麟, 芯片, 海思]') &&
    out.includes('cover: /images/2026/kirin9020-scan.jpg') && out.includes('description: 麒麟 9020 芯片扫描图'));
  ok('提交信息可读', /调整分类/.test(puts[0].message), puts[0].message);
}

console.log('\n【setDate：改日期且保住旧链接】');
{
  puts.length = 0;
  const r = await call({ key: 'TESTKEY', action: 'setDate', path: 'source/_posts/kirin9020-scan.md', date: '2025-09-01 10:00' });
  ok('接口返回成功', r.body.ok, JSON.stringify(r.body));
  ok('标记已护住链接', r.body.permalinkProtected === true);
  const out = puts[0].text;
  ok('新日期写入', out.includes('date: 2025-09-01 10:00:00'), out.match(/date:.*/)?.[0]);
  ok('permalink 固定为旧 URL', out.includes('permalink: /2026/09/06/kirin9020-scan/'), out.match(/permalink:.*/)?.[0]);
  ok('非法日期被拒绝', (await call({ key: 'TESTKEY', action: 'setDate', path: 'source/_posts/kirin9020-scan.md', date: '乱写' })).status === 400);
  ok('路径越权被拒绝', (await call({ key: 'TESTKEY', action: 'setDate', path: 'source/_dynamics/x.md', date: '2025-01-01 00:00' })).status === 400);
}

console.log('\n【renameCategory：重命名并连带后代】');
{
  puts.length = 0;
  const r = await call({ key: 'TESTKEY', action: 'renameCategory', from: '技术', to: '笔记' });
  ok('接口返回成功', r.body.ok, JSON.stringify(r.body));
  ok('命中 1 篇（技术/硬件）', r.body.changed === 1, String(r.body.changed));
  ok('后代一并改为 笔记/硬件', puts[0].text.includes('categories: [笔记, 硬件]'), puts[0].text.match(/categories:.*/)?.[0]);
}

console.log('\n【reorder：整体重排】');
{
  puts.length = 0;
  const before = (await call({ key: 'TESTKEY', action: 'list' })).body.posts;
  const reordered = [...before].reverse();                       // 完全倒序
  const r = await call({ key: 'TESTKEY', action: 'reorder', order: reordered.map((p) => ({ path: p.path })) });
  ok('接口返回成功', r.body.ok, JSON.stringify(r.body));
  ok('产生了提交', puts.length > 0, String(puts.length));
  const after = (await call({ key: 'TESTKEY', action: 'list' })).body.posts;
  console.log('     新顺序:', after.map((p) => p.title.slice(0, 10)).join(' | '));
  ok('新顺序与请求一致',
    after.map((p) => p.slug).join(',') === reordered.map((p) => p.slug).join(','),
    after.map((p) => p.slug).join(','));
  const bySlug = Object.fromEntries(before.map((p) => [p.slug, p.url]));
  const bad = after.filter((p) => !puts.some((x) => x.path === p.path && x.text.includes(`permalink: ${bySlug[p.slug]}`)));
  ok('每篇被改日期的文章都护住了原链接', bad.length === 0, bad.map((p) => p.slug).join(','));
  ok('未知文章被拒绝',
    (await call({ key: 'TESTKEY', action: 'reorder', order: [{ path: 'source/_posts/不存在.md' }] })).status === 400);
}

console.log('\n【服务端未配置密钥】');
{
  const r = await call({ key: 'TESTKEY', action: 'list' }, { GITHUB_TOKEN: 'x' });
  ok('缺 ADMIN_KEY → 500', r.status === 500, JSON.stringify(r.body));
}

console.log(`\n──────── 通过 ${pass} / 失败 ${fail} ────────\n`);
process.exit(fail ? 1 : 0);
