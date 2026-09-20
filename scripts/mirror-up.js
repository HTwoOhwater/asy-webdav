// ============================================================================
// asy-webdav - 本地目录 -> 云端(WebDAV) 单向镜像
// ----------------------------------------------------------------------------
// 把本地某个目录的内容推到 WebDAV 上的某个路径，用来「本地覆盖云端」。
//
//   # 先看差异，不改任何东西（默认就是 dry-run）
//   node scripts/mirror-up.js --local "D:\SyncDisk\obsidian\MyVault" --remote "/obsidian/MyVault"
//
//   # 确认无误后真正执行
//   node scripts/mirror-up.js --local "..." --remote "..." --apply
//
//   # 额外删除「云端有、本地没有」的条目（真正的镜像，破坏性）
//   node scripts/mirror-up.js --local "..." --remote "..." --apply --delete
//
//   # 忽略大小，强制重传所有文件
//   node scripts/mirror-up.js --local "..." --remote "..." --apply --force
//
// 走的是本机 WebDAV 网关（默认 http://127.0.0.1:1901），不直接碰云盘 API，
// 因此不会和 asy-cli 争抢 refresh_token。
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------- 参数
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function has(name) {
  return process.argv.includes('--' + name);
}

const CFG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const LOCAL = arg('local');
const REMOTE = arg('remote');
const APPLY = has('apply');
const DELETE = has('delete');
const FORCE = has('force');
const BASE = String(arg('url', `http://127.0.0.1:${CFG.port || 1901}`)).replace(/\/+$/, '');
const USER = arg('user', CFG.username || 'webdav');
const PASS = arg('pass', CFG.password || '');

if (!LOCAL || !REMOTE) {
  console.error('用法: node scripts/mirror-up.js --local <本地目录> --remote </WebDAV路径> [--apply] [--delete] [--force]');
  process.exit(1);
}
if (!fs.existsSync(LOCAL) || !fs.statSync(LOCAL).isDirectory()) {
  console.error('本地目录不存在: ' + LOCAL);
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS, 'utf8').toString('base64');

// ---------------------------------------------------------------- HTTP 工具
function encodePath(p) {
  return p
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function request(method, urlPath, { body, headers, stream } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + encodePath(urlPath));
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: Object.assign({ Authorization: AUTH }, headers || {}),
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
    if (stream) {
      stream.on('error', reject);
      stream.pipe(req);
    } else {
      if (body) req.write(body);
      req.end();
    }
  });
}

// ---------------------------------------------------------------- 列举云端
function parseResponses(xml) {
  const out = [];
  const blocks = xml.match(/<[^>]*response>[\s\S]*?<\/[^>]*response>/gi) || [];
  for (const blk of blocks) {
    const href = (blk.match(/<[^>]*href>([^<]*)</i) || [])[1];
    if (!href) continue;
    const isDir = /<[^>]*collection\s*\/?>/i.test(blk);
    const len = (blk.match(/<[^>]*getcontentlength>(\d+)</i) || [])[1];
    out.push({ href: hrefToPath(href), isDir, size: isDir ? -1 : Number(len || 0) });
  }
  return out;
}

// webdav-server 返回的 href 是完整绝对 URL（http://host:port/path），
// 有些实现只返回 path。统一归一化成解码后的路径。
function hrefToPath(href) {
  let h = href.trim();
  if (/^https?:\/\//i.test(h)) {
    try {
      h = new URL(h).pathname;
    } catch {
      h = h.replace(/^https?:\/\/[^/]*/i, '');
    }
  }
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

async function listRemote(basePath) {
  // 返回 relPath -> {isDir,size}；relPath 用 '/' 分隔，不带首尾斜杠
  const map = new Map();
  const queue = [basePath.replace(/\/+$/, '') || '/'];
  const seen = new Set();
  const norm = (s) => s.replace(/\/+$/, '') || '/';

  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const res = await request('PROPFIND', dir + '/', { headers: { Depth: '1', 'Content-Type': 'application/xml' } });
    if (res.status !== 207) {
      throw new Error(`PROPFIND ${dir} 返回 ${res.status}${res.body ? ': ' + res.body.slice(0, 200) : ''}`);
    }
    for (const e of parseResponses(res.body)) {
      const p = norm(e.href);
      if (p === norm(dir)) continue; // 自己
      if (!p.startsWith(norm(basePath))) continue;
      let rel = p.slice(norm(basePath).length).replace(/^\/+/, '');
      if (!rel) continue;
      map.set(rel, { isDir: e.isDir, size: e.size });
      if (e.isDir) queue.push(p);
    }
  }
  return map;
}

// ---------------------------------------------------------------- 列举本地
function listLocal(root) {
  const map = new Map();
  (function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        map.set(r, { isDir: true, size: -1, abs });
        walk(abs, r);
      } else if (ent.isFile()) {
        map.set(r, { isDir: false, size: fs.statSync(abs).size, abs });
      }
    }
  })(root, '');
  return map;
}

// ---------------------------------------------------------------- 工具
function human(n) {
  if (n < 0) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function joinRemote(base, rel) {
  return base.replace(/\/+$/, '') + '/' + rel;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  console.log('='.repeat(78));
  console.log('本地  : ' + LOCAL);
  console.log('云端  : ' + REMOTE + '   @ ' + BASE);
  console.log('模式  : ' + (APPLY ? (DELETE ? '执行（含删除）' : '执行（不删除）') : 'DRY-RUN（不修改任何东西）') +
    (FORCE ? '  +强制重传' : ''));
  console.log('='.repeat(78));

  console.log('\n正在列举本地...');
  const local = listLocal(LOCAL);
  const localDirs = [...local.values()].filter((v) => v.isDir).length;
  const localFiles = local.size - localDirs;
  console.log(`  ${local.size} 个条目（${localDirs} 目录 / ${localFiles} 文件）`);

  console.log('正在列举云端（递归 PROPFIND）...');
  const remote = await listRemote(REMOTE);
  const remoteDirs = [...remote.values()].filter((v) => v.isDir).length;
  const remoteFiles = remote.size - remoteDirs;
  console.log(`  ${remote.size} 个条目（${remoteDirs} 目录 / ${remoteFiles} 文件）`);

  // ---------------- 差异
  const dirsToCreate = [];
  const filesToUpload = [];
  const skipped = [];
  const conflicts = []; // 类型不一致（本地文件 vs 云端目录 之类）

  for (const [rel, le] of local) {
    const re = remote.get(rel);
    if (le.isDir) {
      if (!re) dirsToCreate.push(rel);
      else if (!re.isDir) conflicts.push({ rel, why: '本地是目录，云端是文件' });
    } else {
      if (!re) filesToUpload.push({ rel, size: le.size, why: '新增' });
      else if (re.isDir) conflicts.push({ rel, why: '本地是文件，云端是目录' });
      else if (FORCE || re.size !== le.size) {
        filesToUpload.push({ rel, size: le.size, oldSize: re.size, why: FORCE ? '强制' : `大小不同 ${human(re.size)} -> ${human(le.size)}` });
      } else {
        skipped.push(rel);
      }
    }
  }

  const remoteOnly = [];
  for (const [rel, re] of remote) {
    if (!local.has(rel)) remoteOnly.push({ rel, isDir: re.isDir, size: re.size });
  }
  remoteOnly.sort((a, b) => (a.isDir === b.isDir ? a.rel.localeCompare(b.rel) : a.isDir ? -1 : 1));

  // ---------------- 报告
  const uploadBytes = filesToUpload.reduce((s, f) => s + f.size, 0);
  console.log('\n' + '-'.repeat(78));
  console.log('差异汇总');
  console.log('-'.repeat(78));
  console.log(`  【新建目录】 ${dirsToCreate.length}`);
  console.log(`  【上传/覆盖】 ${filesToUpload.length}   合计 ${human(uploadBytes)}`);
  console.log(`  【跳过】     ${skipped.length}   （两边大小相同）`);
  console.log(`  【仅云端】   ${remoteOnly.length}   ${DELETE ? '← 会被删除' : '← 不会动'}`);
  console.log(`  【类型冲突】 ${conflicts.length}`);

  if (conflicts.length) {
    console.log('\n⚠️  类型冲突（需要人工处理，脚本会跳过）：');
    conflicts.slice(0, 20).forEach((c) => console.log('    ' + c.rel + '   (' + c.why + ')'));
  }

  if (filesToUpload.length) {
    console.log('\n将要上传/覆盖的文件：');
    filesToUpload
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 40)
      .forEach((f) => console.log(`    ${f.why.padEnd(28)} ${human(f.size).padStart(10)}  ${f.rel}`));
    if (filesToUpload.length > 40) console.log(`    ... 还有 ${filesToUpload.length - 40} 个`);
  }

  if (dirsToCreate.length) {
    console.log('\n将要新建的目录：');
    dirsToCreate.slice(0, 30).forEach((d) => console.log('    ' + d));
    if (dirsToCreate.length > 30) console.log(`    ... 还有 ${dirsToCreate.length - 30} 个`);
  }

  if (remoteOnly.length) {
    console.log(`\n${DELETE ? '⚠️  将要删除' : '仅存在于云端（本次不动）'}：`);
    remoteOnly.slice(0, 40).forEach((r) => console.log(`    ${r.isDir ? '[D]' : '[F]'} ${human(r.size).padStart(10)}  ${r.rel}`));
    if (remoteOnly.length > 40) console.log(`    ... 还有 ${remoteOnly.length - 40} 个`);
  }

  if (!APPLY) {
    console.log('\n' + '='.repeat(78));
    console.log('DRY-RUN 结束，未做任何修改。确认无误后加 --apply 执行。');
    if (remoteOnly.length && !DELETE) console.log('（云端多出来的条目默认不动；要删就再加 --delete）');
    console.log('='.repeat(78));
    return;
  }

  // ---------------- 执行
  console.log('\n' + '='.repeat(78));
  console.log('开始执行...');
  console.log('='.repeat(78));

  let okDir = 0, okFile = 0, okDel = 0, fail = 0;
  const errors = [];

  // 目录按层级从浅到深
  dirsToCreate.sort((a, b) => a.split('/').length - b.split('/').length);
  for (const rel of dirsToCreate) {
    const res = await request('MKCOL', joinRemote(REMOTE, rel) + '/');
    if (res.status === 201 || res.status === 200 || res.status === 405) okDir++;
    else { fail++; errors.push(`MKCOL ${rel} -> ${res.status}`); }
    if ((okDir + fail) % 20 === 0) process.stdout.write(`\r  目录 ${okDir + fail}/${dirsToCreate.length}`);
  }
  if (dirsToCreate.length) process.stdout.write(`\r  目录 ${okDir} 个已建\n`);

  for (const f of filesToUpload) {
    const abs = local.get(f.rel).abs;
    const st = fs.statSync(abs);
    try {
      const res = await request('PUT', joinRemote(REMOTE, f.rel), {
        stream: fs.createReadStream(abs),
        headers: { 'Content-Length': String(st.size), 'Content-Type': 'application/octet-stream' },
      });
      if (res.status === 200 || res.status === 201 || res.status === 204) okFile++;
      else { fail++; errors.push(`PUT ${f.rel} -> ${res.status} ${res.body.slice(0, 120)}`); }
    } catch (e) {
      fail++;
      errors.push(`PUT ${f.rel} -> ${e.message}`);
    }
    process.stdout.write(`\r  文件 ${okFile + fail}/${filesToUpload.length}   上传 ${okFile}  失败 ${fail}`);
  }
  if (filesToUpload.length) process.stdout.write('\n');

  if (DELETE) {
    // 文件先删，目录从深到浅
    const delFiles = remoteOnly.filter((r) => !r.isDir);
    const delDirs = remoteOnly.filter((r) => r.isDir).sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
    for (const r of [...delFiles, ...delDirs]) {
      const res = await request('DELETE', joinRemote(REMOTE, r.rel));
      if (res.status >= 200 && res.status < 300) okDel++;
      else { fail++; errors.push(`DELETE ${r.rel} -> ${res.status}`); }
      process.stdout.write(`\r  删除 ${okDel + fail - (okFile + okDir)}/${delFiles.length + delDirs.length}`);
    }
    if (delFiles.length + delDirs.length) process.stdout.write('\n');
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`完成：新建目录 ${okDir}，上传文件 ${okFile}，删除 ${okDel}，失败 ${fail}`);
  if (errors.length) {
    console.log('\n失败明细（最多 30 条）：');
    errors.slice(0, 30).forEach((e) => console.log('  ' + e));
  }
  console.log('-'.repeat(78));
}

main().catch((e) => {
  console.error('\n❌ 出错: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
