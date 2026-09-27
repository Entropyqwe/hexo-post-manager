// 本地单元测试：用真实的 source/_posts 文件验证 front-matter 读写不会破坏内容
// 运行: node test/manage.test.mjs /path/to/hexo-firefly-site/source/_posts

import fs from 'node:fs';
import path from 'node:path';
import { __test as T } from '../cloudflare-pages/functions/manage.js';

const DIR = process.argv[2];
if (!DIR || !fs.existsSync(DIR)) {
  console.error('用法: node test/manage.test.mjs <source/_posts 目录>');
  process.exit(2);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md'));
console.log(`\n读取到 ${files.length} 篇文章\n`);

const posts = files.map((f) => {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  return T.parsePost('source/_posts/' + f, 'sha-' + f, text);
});

// ---------------------------------------------------------------- 1. 解析
console.log('【1】front-matter 解析');
for (const p of posts) {
  console.log(`  · ${p.file}\n      title="${p.title}" date=${p.date} cats=[${p.categories}] permalink=${p.permalink || '(无)'} url=${p.url}`);
  ok(`  ${p.file} 解析出标题`, !!p.title);
  ok(`  ${p.file} 解析出日期`, !!p.date);
}
const kirin = posts.find((p) => p.file === 'kirin9020-scan.md');
ok('kirin9020-scan 分类 = 硬件', kirin && kirin.categoryPath === '硬件', kirin && kirin.categoryPath);
ok('kirin9020-scan url 与线上一致', kirin && kirin.url === '/2026/09/06/kirin9020-scan/', kirin && kirin.url);
const kaizhan = posts.find((p) => p.file === '开站啦.md');
ok('开站啦 url 正确（含中文 slug）', kaizhan && kaizhan.url === '/2024/05/02/开站啦/', kaizhan && kaizhan.url);

// ---------------------------------------------------------------- 2. 无改动必须逐字节相同
console.log('\n【2】不改任何字段时，重新序列化必须与原文件完全相同');
for (const p of posts) {
  const { fields, body } = T.splitFM(p._text);
  const rebuilt = T.buildFM(fields, body);
  ok(`  ${p.file} 往返一致`, rebuilt === p._text, rebuilt === p._text ? '' : '存在差异');
}

// ---------------------------------------------------------------- 3. 移动分类
console.log('\n【3】移动分类（setCategory 等价操作）: kirin9020-scan → 技术/硬件');
{
  const { fields, body } = T.splitFM(kirin._text);
  T.setRaw(fields, 'categories', T.yList(['技术', '硬件']));
  const out = T.buildFM(fields, body);
  console.log('--- 改写结果 ---\n' + out.split('\n').slice(0, 10).map((l) => '      ' + l).join('\n'));
  ok('  新分类已写入', /categories: \[技术, 硬件\]/.test(out), out.match(/categories:.*/)?.[0]);
  ok('  title 保留', out.includes('title: 麒麟9020扫描图'));
  ok('  tags 保留', out.includes('tags: [麒麟, 芯片, 海思]'));
  ok('  cover 保留', out.includes('cover: /images/2026/kirin9020-scan.jpg'));
  ok('  description 保留', out.includes('description: 麒麟 9020 芯片扫描图'));
  ok('  正文保留', out.includes('---\n') && out.length > kirin._text.length - 60);
}

// ---------------------------------------------------------------- 4. 改日期 + 保住旧链接
console.log('\n【4】改日期（setDate 等价操作）: kirin9020-scan 2026-09-06 → 2025-09-01');
{
  const { fields, body } = T.splitFM(kirin._text);
  const old = T.parseDate(T.getRaw(fields, 'date'));
  const kept = T.protectPermalink(fields, old, kirin.slug);
  T.setRaw(fields, 'date', T.fmtDate(T.parseDate('2025-09-01 10:00')));
  const out = T.buildFM(fields, body);
  console.log('--- 改写结果 ---\n' + out.split('\n').slice(0, 9).map((l) => '      ' + l).join('\n'));
  // 注意：文章可能已经有 permalink（之前用面板改过顺序就会写入），
  // 所以这里断言的是"旧链接被固定住"，而不是"本次新写入"
  const plRe = /permalink: '?\/2026\/09\/06\/kirin9020-scan\/'?/;
  ok('  旧链接被 permalink 固定住', plRe.test(out), out.match(/permalink:.*/)?.[0]);
  ok('  permalink 只出现一次', (out.match(/^permalink:/gm) || []).length === 1);
  ok('  新日期已写入', out.includes('date: 2025-09-01 10:00:00'));
  ok('  protectPermalink 语义正确（已有则不重复写）',
     kept === !/^permalink:/m.test(kirin._text), `kept=${kept}`);
}

// ---------------------------------------------------------------- 5. 已有 permalink 不覆盖（幂等）
console.log('\n【5】幂等性：已有 permalink 的文章再次改日期，permalink 不变');
{
  let text = kirin._text;
  for (const d of ['2025-09-01 10:00', '2024-01-01 09:00']) {
    const { fields, body } = T.splitFM(text);
    const old = T.parseDate(T.getRaw(fields, 'date'));
    T.protectPermalink(fields, old, kirin.slug);
    T.setRaw(fields, 'date', T.fmtDate(T.parseDate(d)));
    text = T.buildFM(fields, body);
  }
  const pl = (text.match(/permalink:.*/) || [''])[0];
  ok('  两次改日期后 permalink 仍是原始 URL', pl.includes('/2026/09/06/kirin9020-scan/'), pl);
  ok('  只出现一次 permalink', (text.match(/^permalink:/gm) || []).length === 1);
}

// ---------------------------------------------------------------- 6. 重排顺序
console.log('\n【6】重排顺序（reorder 等价操作）：把「开站啦」拖到第 1 位');
{
  const order = [...posts].sort((a, b) => b.dateVal - a.dateVal);
  // 把最早的开站啦移到最前
  const kz = order.find((p) => p.file === '开站啦.md');
  const rest = order.filter((p) => p !== kz);
  const desired = [kz, ...rest];

  const pool = posts.map((p) => p.dateVal).sort((a, b) => b - a);
  let prev = null;
  const result = desired.map((p, i) => {
    let v = pool[i];
    if (prev != null && v >= prev) v = prev - 1000;
    prev = v;
    const { fields, body } = T.splitFM(p._text);
    T.protectPermalink(fields, T.parseDate(p.dateRaw), p.slug);
    T.setRaw(fields, 'date', T.fmtDate(fromValLocal(v)));
    const out = T.buildFM(fields, body);
    return { file: p.file, oldDate: p.date, oldUrl: p.url, newDate: T.fmtDate(fromValLocal(v)), newUrlField: (out.match(/permalink:.*/) || [''])[0] };
  });
  result.forEach((r, i) => console.log(`  ${i + 1}. ${r.file}\n       ${r.oldDate} → ${r.newDate}   旧链接 ${r.oldUrl}`));
  ok('  开站啦排到第 1 位', result[0].file === '开站啦.md');
  ok('  所有文章都固定了旧链接', result.every((r) => r.newUrlField.includes(r.oldUrl.replace(/\/$/, ''))));
  ok('  新日期严格递减', result.every((r, i) => i === 0 || result[i - 1].newDate > r.newDate));
}

function fromValLocal(v) {
  const d = new Date(v);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

console.log(`\n──────── 通过 ${pass} / 失败 ${fail} ────────\n`);
process.exit(fail ? 1 : 0);
