// ============================================================================
// asy-webdav - rename / move / copy 的 ondup 语义探测器
// ----------------------------------------------------------------------------
// osbeginupload 的语义已经由 probe-ondup.js 确定（1=拒绝 2=保留两者 3=覆盖），
// 但实测 file/rename 用 3 会报「HTTP 403 当前操作不支持覆盖」——
// 说明这几个接口接受的取值并不一致。这里逐个探清楚。
//
//   node scripts/probe-rename.js --root /WebDAV/asy-webdav-test
//
// 实验设计：每个 ondup 用独立文件名，全程不做删除（云盘删除是最终一致的）。
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const asy = require('../lib/asy-cli');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = arg('root', '/WebDAV/asy-webdav-test');
const PREFIX = 'probe-ren';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = asy.config.load();
  const api = new asy.AnyShareApi(cfg);
  const dir = await api.resolvePath(ROOT);
  console.log('测试目录: ' + ROOT);
  console.log('');

  async function upload(name, content) {
    const tmp = path.join(os.tmpdir(), `${PREFIX}-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(tmp, content);
    try {
      await asy.uploadFile(api, tmp, dir.docid, name, { ondup: 1 });
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message.replace(/^POST [^ ]+ 失败: /, '') };
    } finally {
      fs.unlink(tmp, () => {});
    }
  }

  async function snapshot() {
    const { files } = await api.listFolder(dir.docid);
    return files
      .filter((f) => f.name.startsWith(PREFIX))
      .map((f) => ({ name: f.name, size: f.size, docid: f.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function find(name) {
    const s = await snapshot();
    return s.find((x) => x.name === name) || null;
  }

  // 清理上次残留
  {
    const { files } = await api.listFolder(dir.docid);
    for (const f of files) {
      if (f.name.startsWith(PREFIX)) await api.remove([{ docid: f.id, type: 'file' }]);
    }
    await sleep(1000);
  }

  const A = Buffer.from('A'.repeat(20)); // 源文件 20 字节
  const B = Buffer.from('B'.repeat(30)); // 目标已存在 30 字节

  console.log('场景：目录里同时存在 src(20B) 与 dst(30B)，把 src 重命名成 dst 的名字');
  console.log('-'.repeat(74));

  const results = [];
  for (const ondup of [1, 2, 3]) {
    const srcName = `${PREFIX}-src-${ondup}.txt`;
    const dstName = `${PREFIX}-dst-${ondup}.txt`;

    const r1 = await upload(srcName, A);
    const r2 = await upload(dstName, B);
    if (!r1.ok || !r2.ok) {
      console.log(`ondup=${ondup}: ⚠️  准备文件失败 ${r1.err || r2.err}`);
      continue;
    }
    const srcNode = await find(srcName);
    if (!srcNode) {
      console.log(`ondup=${ondup}: ⚠️  找不到源文件`);
      continue;
    }

    let err = null;
    try {
      await api.rename(srcNode.docid, dstName, ondup);
    } catch (e) {
      err = e.message.replace(/^POST [^ ]+ 失败: /, '');
    }
    await sleep(800);

    const after = await snapshot();
    const mine = after.filter((x) => x.name.includes(`-${ondup}.txt`));
    let verdict;
    if (err) {
      verdict = `🚫 失败 — ${err}`;
    } else {
      const dst = mine.find((x) => x.name === dstName);
      const extra = mine.filter((x) => x.name !== dstName && x.name !== srcName);
      if (extra.length) verdict = `🔀 保留两者（改名成 ${extra.map((e) => e.name).join(', ')}）`;
      else if (dst && dst.size === A.length) verdict = `✅ 覆盖目标（dst 变成 20B）`;
      else if (dst && dst.size === B.length) verdict = `❓ 调用成功但目标没变（仍是 30B）`;
      else verdict = `❓ 结果不明`;
    }
    results.push({ ondup, verdict });
    console.log(`ondup=${ondup}: ${verdict}`);
    console.log(`         文件 -> ${mine.map((m) => `${m.name}(${m.size})`).join(', ') || '(无)'}`);
  }

  console.log('-'.repeat(74));
  console.log('');
  console.log('结论 (file/rename):');
  for (const r of results) console.log(`  ondup=${r.ondup}  ${r.verdict}`);

  // 清理
  const { files } = await api.listFolder(dir.docid);
  for (const f of files) {
    if (f.name.startsWith(PREFIX)) await api.remove([{ docid: f.id, type: 'file' }]);
  }
  await sleep(1200);
  const left = await snapshot();
  console.log('');
  console.log('已清空测试目录: ' + (left.length === 0 ? '是' : left.map((x) => x.name).join(', ')));
}

main().catch((e) => {
  console.error('探测失败: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
