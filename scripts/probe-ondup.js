// ============================================================================
// asy-webdav - ondup 语义探测器
// ----------------------------------------------------------------------------
// 文档里对 ondup 的说法不够准确：实测 ondup=1 遇到同名会报
// 「HTTP 403 存在同类型的同名文件名」，而不是覆盖。
// 这个脚本对真实云盘做干净的对照实验，确定每个取值到底是「拒绝 / 覆盖 / 自动改名」。
//
//   node scripts/probe-ondup.js --root /WebDAV/asy-webdav-test
//
// 实验设计：每个 ondup 用**独立文件名**，全程不做删除 —— 因为实测云盘删除是
// 最终一致的，删掉再立刻用同名上传会莫名其妙触发自动改名，污染对照。
//
// 只在 --root 目录里操作，结束时清空该目录下的所有文件。
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
const PREFIX = 'probe-ondup';
const ORIG = Buffer.from('O'.repeat(20)); // 基准内容 20 字节

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = asy.config.load();
  const api = new asy.AnyShareApi(cfg);
  const dir = await api.resolvePath(ROOT);
  console.log('测试目录: ' + ROOT + '  ' + dir.docid);
  console.log('基准内容: 20 字节的 "O"；重传内容长度 = 10 + ondup（方便一眼看出被换成哪个）');
  console.log('');

  /** 复用 asy-cli 的 uploadFile（同时处理 PUT 直传与 POST multipart） */
  async function upload(name, content, ondup) {
    const tmp = path.join(os.tmpdir(), `${PREFIX}-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(tmp, content);
    try {
      await asy.uploadFile(api, tmp, dir.docid, name, { ondup });
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message.replace(/^POST [^ ]+ 失败: /, '') };
    } finally {
      fs.unlink(tmp, () => {});
    }
  }

  async function snapshot() {
    const { dirs, files } = await api.listFolder(dir.docid);
    return [...dirs.map((d) => `${d.name}/`), ...files.map((f) => `${f.name}(${f.size})`)].sort();
  }

  // 清掉上一次可能残留的探测文件
  {
    const { files } = await api.listFolder(dir.docid);
    for (const f of files) {
      if (f.name.startsWith(PREFIX)) await api.remove([{ docid: f.id, type: 'file' }]);
    }
    await sleep(1000);
  }

  console.log('对照实验：目录里先放一份基准文件，再用同一个名字、不同 ondup 传新内容');
  console.log('-'.repeat(74));

  const verdicts = [];
  for (const ondup of [1, 2, 3, 4]) {
    const name = `${PREFIX}-${ondup}.txt`;
    const content = Buffer.from('T'.repeat(10 + ondup));

    const base = await upload(name, ORIG, 1);
    if (!base.ok) {
      verdicts.push({ ondup, verdict: `⚠️ 基准创建失败 — ${base.err}` });
      console.log(`ondup=${ondup}: ⚠️  基准创建失败 — ${base.err}`);
      continue;
    }

    const res = await upload(name, content, ondup);
    await sleep(800);
    const after = await snapshot();
    const mine = after.filter((x) => x.startsWith(`${PREFIX}-${ondup}`));

    let verdict;
    if (!res.ok) {
      verdict = `🚫 拒绝同名 — ${res.err}`;
    } else if (mine.length > 1) {
      verdict = `🔀 保留两者（自动改名）`;
    } else if (mine.length === 1 && mine[0] === `${name}(${content.length})`) {
      verdict = `✅ 覆盖（原文件被替换）`;
    } else {
      verdict = `❓ 结果不明`;
    }
    verdicts.push({ ondup, verdict, files: mine });
    console.log(`ondup=${ondup}: ${verdict}`);
    console.log(`         该名字下的文件 -> ${mine.join(', ') || '(无)'}`);
  }

  console.log('-'.repeat(74));
  console.log('');
  console.log('结论:');
  for (const v of verdicts) console.log(`  ondup=${v.ondup}  ${v.verdict}`);

  // 清理
  const { files } = await api.listFolder(dir.docid);
  for (const f of files) {
    if (f.name.startsWith(PREFIX)) await api.remove([{ docid: f.id, type: 'file' }]);
  }
  await sleep(1200);
  const finalState = await snapshot();
  console.log('');
  console.log('已清空测试目录: ' + (finalState.length === 0 ? '是' : finalState.join(', ')));
}

main().catch(async (e) => {
  console.error('探测失败: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
