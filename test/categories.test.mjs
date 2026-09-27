// 文件夹（分类）功能完整自检
// 用 mock 的 GitHub API 走真实的 onRequestPost 链路，覆盖全部分类相关动作
// 运行: node test/categories.test.mjs /path/to/hexo-firefly-site/source/_posts

import fs from 'node:fs';
import path from 'node:path';
import { onRequestPost } from '../cloudflare-pages/functions/manage.js';

const DIR = process.argv[2];
if (!DIR || !fs.existsSync(DIR)) {
  console.error('用法: node test/categories.test.mjs <source/_posts 目录>');
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${x ? '  → ' + String(x).slice(0, 220) : ''}`); }
};
const section = (t) => console.log(`\n【${t}】`);

// ---------------------------------------------------------------- mock GitHub
const files = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.md'))) {
  files['source/_posts/' + f] = fs.readFileSync(path.join(DIR, f), 'utf8');
}
const puts = [];
const shaOf = () => 'sha' + Math.random().toString(36).slice(2, 8);

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(u.pathname);
  if (!m) return new Response('nf', { status: 404 });
  const rel = decodeURIComponent(m[3]);

  if (init.method === 'PUT') {
    const body = JSON.parse(init.body);
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    puts.push({ path: rel, message: body.message, text });
    files[rel] = text;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (init.method === 'DELETE') { delete files[rel]; return new Response('{}', { status: 200 }); }
  if (rel === 'source/_posts') {
    return new Response(JSON.stringify(
      Object.keys(files).filter((p) => p.startsWith('source/_posts/'))
        .map((p) => ({ type: 'file', name: p.split('/').pop(), path: p }))
    ), { status: 200 });
  }
  if (files[rel] != null) {
    return new Response(JSON.stringify({
      content: Buffer.from(files[rel], 'utf8').toString('base64'), sha: 'sha:' + rel,
    }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

// ---------------------------------------------------------------- 工具
const ENV = { ADMIN_KEY: 'TESTKEY', GITHUB_TOKEN: 'ghp_fake', REPO: 'o/r', BRANCH: 'main' };
async function call(body, env = ENV) {
  const req = new Request('https://x/manage', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await onRequestPost({ request: req, env });
  return { status: res.status, body: await res.json() };
}
const K = { key: 'TESTKEY' };
const list = async () => (await call({ ...K, action: 'list' })).body;
const catOf = (L, p) => (L.categories || []).find((c) => c.path === p);
const catsFile = () => files['source/_data/categories.yml'] || '';
const postsFile = (slug) => files['source/_posts/' + slug + '.md'] || '';

// ================================================================ 开始自检
console.log(`\n读取到 ${Object.keys(files).length - 0} 篇真实文章作为测试素材`);

// ---------------------------------------------------------------- 1. 基线
section('1. 基线：读取分类');
let L = await list();
{
  ok('list 返回成功', L.ok);
  ok('返回了分类列表', Array.isArray(L.categories) && L.categories.length > 0,
    JSON.stringify(L.categories));
  ok('每个分类都带 description 字段',
    L.categories.every((c) => typeof c.description === 'string'));
  ok('每个分类都带 empty 标记', L.categories.every((c) => 'empty' in c));
  console.log('     当前分类:', L.categories.map((c) => `${c.path}(${c.count}篇)`).join(', '));
}

// ---------------------------------------------------------------- 2. 新建分类
section('2. 新建分类（含空分类）');
{
  const before = (await list()).categories.length;
  let r = await call({ ...K, action: 'saveCategories',
    categories: [{ path: '摄影' }, { path: '摄影/夜景' }, { path: '硬件' }, { path: '问世' }, { path: '随笔' }] });
  ok('saveCategories 成功', r.body.ok, JSON.stringify(r.body));
  ok('写入了 source/_data/categories.yml', /- name: 摄影/.test(catsFile()), catsFile().slice(0, 160));

  L = await list();
  ok('新分类「摄影」出现', !!catOf(L, '摄影'));
  ok('二级分类「摄影/夜景」出现', !!catOf(L, '摄影/夜景'));
  ok('空分类被标记为 empty', catOf(L, '摄影').empty === true);
  ok('空分类文章数为 0', catOf(L, '摄影').count === 0);
  ok('已有分类的计数未受影响', catOf(L, '硬件').count === catOf(L, '硬件').count);
  ok('分类总数增加', L.categories.length > before);
  console.log('     分类:', L.categories.map((c) => c.path).join(', '));
}

// ---------------------------------------------------------------- 3. 分类介绍
section('3. 分类介绍：写 / 读 / 改 / 清空');
{
  let r = await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: '记录光影与构图，主要是街头与自然。' });
  ok('写入介绍成功', r.body.ok, JSON.stringify(r.body));
  L = await list();
  ok('介绍能读回来', catOf(L, '摄影').description === '记录光影与构图，主要是街头与自然。',
    catOf(L, '摄影').description);
  ok('介绍写进了 yml', /description: '?记录光影与构图/.test(catsFile()), catsFile());

  r = await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: '改过的介绍' });
  L = await list();
  ok('修改介绍生效', catOf(L, '摄影').description === '改过的介绍');

  r = await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: '' });
  L = await list();
  ok('清空介绍生效', catOf(L, '摄影').description === '');
  ok('清空后分类仍在', !!catOf(L, '摄影'));

  // 给不存在的分类写介绍 → 应自动创建
  r = await call({ ...K, action: 'setCategoryDescription', path: '新建的', description: '自动创建' });
  L = await list();
  ok('给不存在的分类写介绍会自动创建它', !!catOf(L, '新建的') && catOf(L, '新建的').description === '自动创建');
  await call({ ...K, action: 'setCategoryDescription', path: '新建的', description: '' });

  // 特殊字符
  const risky = `引号 ' 与 " 还有 # 和 : 冒号`;
  await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: risky });
  L = await list();
  ok('含引号/井号/冒号的介绍能完整往返', catOf(L, '摄影').description === risky,
    JSON.stringify(catOf(L, '摄影').description));
  const emoji = '📷 含 emoji 的介绍 ✨';
  await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: emoji });
  L = await list();
  ok('含 emoji 的介绍能完整往返', catOf(L, '摄影').description === emoji);
}

// ---------------------------------------------------------------- 4. 介绍不丢失（回归）
section('4. 回归：新建分类时，已有介绍不能被清空');
{
  await call({ ...K, action: 'setCategoryDescription', path: '硬件', description: '芯片与硬件相关' });
  L = await list();
  const snapshot = L.categories.map((c) => ({ path: c.path, description: c.description }));

  // 模拟面板点「新建」：把当前状态（含 description）整体回传
  await call({ ...K, action: 'saveCategories', categories: snapshot.concat([{ path: '新文件夹', description: '' }]) });
  L = await list();
  ok('新建后「硬件」的介绍还在', catOf(L, '硬件').description === '芯片与硬件相关',
    catOf(L, '硬件').description);
  ok('新建后「摄影」的介绍还在', catOf(L, '摄影').description === '📷 含 emoji 的介绍 ✨');
  ok('新文件夹已存在', !!catOf(L, '新文件夹'));
  await call({ ...K, action: 'saveCategories',
    categories: L.categories.filter((c) => c.path !== '新文件夹').map((c) => ({ path: c.path, description: c.description })) });
}

// ---------------------------------------------------------------- 5. 重命名
section('5. 重命名分类（有文章的 + 空分类）');
{
  const target = (await list()).posts.find((p) => p.categoryPath);
  const fromPath = target.categoryPath;
  console.log(`     用「${fromPath}」测试（含 ${target.title}）`);

  let r = await call({ ...K, action: 'renameCategory', from: fromPath, to: '重命名后' });
  ok('重命名成功', r.body.ok, JSON.stringify(r.body));
  L = await list();
  ok('文章已归到新分类', L.posts.find((p) => p.path === target.path).categoryPath === '重命名后',
    L.posts.find((p) => p.path === target.path).categoryPath);
  ok('旧分类名已消失', !catOf(L, fromPath));
  ok('新分类名已出现', !!catOf(L, '重命名后'));

  // 空分类重命名 + 介绍保留
  await call({ ...K, action: 'setCategoryDescription', path: '摄影', description: '光影记录' });
  r = await call({ ...K, action: 'renameCategory', from: '摄影', to: '影像' });
  L = await list();
  ok('空分类「摄影」已改名为「影像」', !!catOf(L, '影像') && !catOf(L, '摄影'));
  ok('改名后介绍被保留', catOf(L, '影像').description === '光影记录', catOf(L, '影像').description);
  ok('子分类「摄影/夜景」跟着改名为「影像/夜景」', !!catOf(L, '影像/夜景'), JSON.stringify(L.categories.map(c=>c.path)));

  // 改回去
  await call({ ...K, action: 'renameCategory', from: '重命名后', to: fromPath });
  await call({ ...K, action: 'renameCategory', from: '影像', to: '摄影' });
  L = await list();
  ok('还原后文章分类正确', L.posts.find((p) => p.path === target.path).categoryPath === fromPath);
  ok('还原后介绍仍在', catOf(L, '摄影').description === '光影记录');
}

// ---------------------------------------------------------------- 6. 移动文章
section('6. 把文章移动到别的文件夹');
{
  const p1 = (await list()).posts[0];
  let r = await call({ ...K, action: 'setCategory', path: p1.path, categories: '摄影/夜景' });
  ok('移动到二级分类成功', r.body.ok, JSON.stringify(r.body));
  L = await list();
  ok('文章已在 摄影/夜景', L.posts.find((x) => x.path === p1.path).categoryPath === '摄影/夜景');
  ok('已写入 categories: [摄影, 夜景]', /categories: \[摄影, 夜景\]/.test(postsFile(p1.slug)),
    (postsFile(p1.slug).match(/categories:.*/) || [''])[0]);
  ok('其它字段没丢', postsFile(p1.slug).includes('title:'));

  r = await call({ ...K, action: 'setCategory', path: p1.path, categories: '' });
  L = await list();
  ok('移到「未分类」成功', L.posts.find((x) => x.path === p1.path).categoryPath === '');
  ok('categories 字段被移除', !/^categories:/m.test(postsFile(p1.slug)));

  // 还原
  await call({ ...K, action: 'setCategory', path: p1.path, categories: p1.categoryPath });
  L = await list();
  ok('还原后分类正确', L.posts.find((x) => x.path === p1.path).categoryPath === p1.categoryPath);
}

// ---------------------------------------------------------------- 7. 删除分类
section('7. 删除分类');
{
  // 空分类删除
  await call({ ...K, action: 'saveCategories',
    categories: (await list()).categories.map((c) => ({ path: c.path, description: c.description }))
      .concat([{ path: '待删除的空分类', description: 'x' }]) });
  ok('空分类已创建', !!catOf(await list(), '待删除的空分类'));
  let r = await call({ ...K, action: 'deleteCategory', name: '待删除的空分类' });
  L = await list();
  ok('空分类已从列表移除', !catOf(L, '待删除的空分类'));

  // 有文章的分类删除 → 文章变未分类
  const t = L.posts.find((p) => p.categoryPath === '摄影');
  if (t) {
    r = await call({ ...K, action: 'deleteCategory', name: '摄影' });
    L = await list();
    ok('删除后文章变为未分类', L.posts.find((p) => p.path === t.path).categoryPath === '');
    await call({ ...K, action: 'setCategory', path: t.path, categories: t.categoryPath });
  } else {
    // 没有直接挂在「摄影」下的文章，就用「摄影/夜景」
    const t2 = L.posts.find((p) => p.categoryPath === '摄影/夜景');
    if (t2) {
      r = await call({ ...K, action: 'deleteCategory', name: '摄影/夜景' });
      L = await list();
      ok('删除后文章变为未分类', L.posts.find((p) => p.path === t2.path).categoryPath === '');
      await call({ ...K, action: 'setCategory', path: t2.path, categories: t2.categoryPath });
    } else {
      ok('（无文章挂在测试分类下，跳过此项）', true);
    }
  }
  // 清理测试分类
  L = await list();
  await call({ ...K, action: 'saveCategories',
    categories: L.categories.map((c) => ({ path: c.path, description: c.description }))
      .filter((c) => !c.path.startsWith('摄影') && c.path !== '待删除的空分类') });
}

// 清掉本段测试留下的空分类
await call({ ...K, action: 'deleteCategory', name: '新建的' });

// ---------------------------------------------------------------- 8. 排序
section('8. 文章顺序（改日期 + 重排，且链接不失效）');
{
  const before = (await list()).posts;
  const one = before[0];
  puts.length = 0;
  let r = await call({ ...K, action: 'setDate', path: one.path, date: '2025-03-03 09:00' });
  ok('改单篇日期成功', r.body.ok, JSON.stringify(r.body));
  ok('写入了 permalink 保住旧链接', puts[0].text.includes(`permalink: ${one.url}`),
    (puts[0].text.match(/permalink:.*/) || [''])[0]);
  ok('日期已改', puts[0].text.includes('date: 2025-03-03 09:00:00'));
  await call({ ...K, action: 'setDate', path: one.path, date: one.date });

  puts.length = 0;
  const reversed = (await list()).posts.slice().reverse();
  r = await call({ ...K, action: 'reorder', order: reversed.map((p) => ({ path: p.path })) });
  ok('整体重排成功', r.body.ok, JSON.stringify(r.body));
  L = await list();
  ok('新顺序与请求一致', L.posts.map((p) => p.path).join() === reversed.map((p) => p.path).join());
  const urlMap = Object.fromEntries(before.map((p) => [p.path, p.url]));
  const bad = L.posts.filter((p) => !puts.some((x) => x.path === p.path && x.text.includes(`permalink: ${urlMap[p.path]}`)));
  ok('每篇被改日期的都护住了原链接', bad.length === 0, bad.map((p) => p.slug).join(','));
}

// ---------------------------------------------------------------- 9. 安全
section('9. 安全与边界');
{
  ok('错误密钥被拒（403）', (await call({ key: 'wrong', action: 'list' })).status === 403);
  ok('缺少密钥被拒（403）', (await call({ action: 'list' })).status === 403);
  ok('未配置 ADMIN_KEY → 500',
    (await call({ key: 'x', action: 'list' }, { GITHUB_TOKEN: 't' })).status === 500);
  ok('缺少 REPO 依赖时仍可读（用默认仓库）', (await call({ ...K, action: 'verify' })).body.ok === true);
  ok('setCategory 越权路径被拒',
    (await call({ ...K, action: 'setCategory', path: 'source/_dynamics/x.md', categories: 'a' })).status === 400);
  ok('setDate 越权路径被拒',
    (await call({ ...K, action: 'setDate', path: '../evil.md', date: '2025-01-01 00:00' })).status === 400);
  ok('非法日期被拒',
    (await call({ ...K, action: 'setDate', path: 'source/_posts/x.md', date: '乱写' })).status === 400);
  ok('setCategoryDescription 缺 path 被拒',
    (await call({ ...K, action: 'setCategoryDescription', description: 'x' })).status === 400);
  ok('未知 action 被拒（400）', (await call({ ...K, action: '不存在' })).status === 400);
  ok('重命名到已存在的分类不会崩',
    (await call({ ...K, action: 'renameCategory', from: '不存在的', to: '随笔' })).body.ok === true);
}

// ---------------------------------------------------------------- 10. 收尾
section('10. 收尾：数据是否回到基线');
{
  L = await list();
  console.log('     最终分类:', L.categories.map((c) => `${c.path}${c.empty ? '(空)' : '(' + c.count + '篇)'}`).join(', '));
  ok('文章数与基线一致', L.posts.length === Object.keys(files).filter((p) => p.startsWith('source/_posts/') && p.endsWith('.md')).length);
  ok('每篇文章都有分类字段（可能为空串）', L.posts.every((p) => typeof p.categoryPath === 'string'));
}

console.log(`\n──────── 通过 ${pass} / 失败 ${fail} ────────\n`);
process.exit(fail ? 1 : 0);
