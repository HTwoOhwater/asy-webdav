// ============================================================================
// asy-webdav - 真实云盘冒烟测试
// ----------------------------------------------------------------------------
// 起一个真实网关，对**真实**山大云盘的一个专用测试目录跑完整读写流程。
//
//   node scripts/live-smoke.js --root /WebDAV/asy-webdav-test --port 1902
//
// 安全约定：
//   * 只会动 --root 指定的那个目录，默认是 /WebDAV/asy-webdav-test
//   * 结束时会把自己建的东西全删掉（脚本自己再校验一遍目录是空的）
//   * 不修改 config.json
// ============================================================================

'use strict';

const crypto = require('crypto');
const path = require('path');
const net = require('net');
const { v2: webdav } = require('webdav-server');

const asy = require('../lib/asy-cli');
const { AnyShareClient } = require('../lib/client');
const { AnyShareFileSystem } = require('../lib/anyshare-fs');

// ---------------------------------------------------------------- 参数
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = arg('root', '/WebDAV/asy-webdav-test');
const PORT = Number(arg('port', '1902'));
const USER = arg('user', 'webdav');
const PASS = arg('pass', 'live-smoke');
const BIG_MB = Number(arg('bigmb', '3'));

// ---------------------------------------------------------------- 结果收集
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ---------------------------------------------------------------- 主流程
let server = null;
let client = null;
let base = '';
let auth = '';

async function req(method, p, opts = {}) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ Authorization: auth }, opts.headers || {}),
    body: opts.body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf, text: buf.toString('utf8') };
}

async function main() {
  const cfg = asy.config.load();
  if (!cfg.refreshToken) throw new Error('未登录 asy-cli，请先 asy login --cas');

  console.log('='.repeat(70));
  console.log('asy-webdav 真实云盘冒烟测试');
  console.log('  云盘实例 : ' + cfg.baseUrl);
  console.log('  账号     : ' + (cfg.rootName || '?'));
  console.log('  测试目录 : ' + ROOT);
  console.log('='.repeat(70));

  client = new AnyShareClient({
    cfg,
    basePath: ROOT,
    ttlMs: 3000, // 真实测试用短 TTL，避免缓存掩盖问题
    concurrency: 3,
  });
  const vfs = new AnyShareFileSystem(client, {
    log: (level, msg) => {
      if (level === 'error') console.error('   [fs] ' + msg);
    },
  });

  // 先确认测试目录存在（用 asy-cli 的既有解析逻辑）
  const rootEntry = await client.rootEntry();
  console.log('测试目录 docid: ' + rootEntry.docid);
  console.log('');

  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser(USER, PASS, false);
  const privilegeManager = new webdav.SimplePathPrivilegeManager();
  privilegeManager.setRights(user, '/', ['all']);
  auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

  const port = PORT || (await freePort());
  base = `http://127.0.0.1:${port}`;

  server = new webdav.WebDAVServer({
    port,
    hostname: '127.0.0.1',
    httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'asy-webdav-live'),
    privilegeManager,
    requireAuthentification: true,
  });
  await new Promise((resolve, reject) => {
    server.setFileSystem('/', vfs, (ok) => {
      if (!ok) return reject(new Error('setFileSystem 失败'));
      server.start(() => resolve());
    });
  });
  console.log('网关已启动: ' + base + '\n');

  // ---------------- 1. PROPFIND 根 ----------------
  let r = await req('PROPFIND', '/', { headers: { Depth: '1' } });
  record('PROPFIND / Depth:1', r.status === 207, `HTTP ${r.status}, ${r.text.length} 字节 XML`);

  // ---------------- 2. MKCOL ----------------
  r = await req('MKCOL', '/sub');
  record('MKCOL /sub', r.status === 201, `HTTP ${r.status}`);

  // ---------------- 3. PUT 小文件（流式） ----------------
  const small = Buffer.from('hello anyshare webdav @ ' + new Date().toISOString(), 'utf8');
  r = await req('PUT', '/sub/hello.txt', {
    headers: { 'Content-Length': String(small.length) },
    body: small,
  });
  record('PUT /sub/hello.txt (流式)', r.status === 201, `HTTP ${r.status}, ${small.length} B`);

  // ---------------- 4. GET 校验 ----------------
  r = await req('GET', '/sub/hello.txt');
  const gotSmall = r.body;
  record(
    'GET /sub/hello.txt 内容一致',
    r.status === 200 && sha(gotSmall) === sha(small),
    `HTTP ${r.status}, sha ${sha(gotSmall)} vs ${sha(small)}`
  );

  // ---------------- 5. PUT 大文件（流式 + 分片压力） ----------------
  const big = crypto.randomBytes(BIG_MB * 1024 * 1024);
  const t0 = Date.now();
  r = await req('PUT', '/sub/big.bin', {
    headers: { 'Content-Length': String(big.length) },
    body: big,
  });
  const upMs = Date.now() - t0;
  record(
    `PUT /sub/big.bin (${BIG_MB} MB 流式)`,
    r.status === 201,
    `HTTP ${r.status}, ${(big.length / 1048576 / (upMs / 1000)).toFixed(2)} MB/s`
  );

  const t1 = Date.now();
  r = await req('GET', '/sub/big.bin');
  const downMs = Date.now() - t1;
  record(
    `GET /sub/big.bin 内容一致`,
    r.status === 200 && r.body.length === big.length && sha(r.body) === sha(big),
    `HTTP ${r.status}, ${r.body.length} B, sha ${sha(r.body)} vs ${sha(big)}, ` +
      `${(big.length / 1048576 / (downMs / 1000)).toFixed(2)} MB/s`
  );

  // ---------------- 6. 覆盖写入 ----------------
  const v2 = Buffer.from('v2-overwritten', 'utf8');
  r = await req('PUT', '/sub/hello.txt', {
    headers: { 'Content-Length': String(v2.length) },
    body: v2,
  });
  const rGet = await req('GET', '/sub/hello.txt');
  record(
    'PUT 覆盖已存在文件 (ondup=3)',
    [200, 204].includes(r.status) && rGet.text === 'v2-overwritten',
    `PUT HTTP ${r.status}, GET 得到 "${rGet.text}"`
  );

  // ---------------- 7. 中文文件名 ----------------
  const cn = Buffer.from('中文内容测试', 'utf8');
  r = await req('PUT', '/sub/%E4%B8%AD%E6%96%87.txt', {
    headers: { 'Content-Length': String(cn.length) },
    body: cn,
  });
  const rCn = await req('GET', '/sub/%E4%B8%AD%E6%96%87.txt');
  record(
    'PUT/GET 中文文件名',
    r.status === 201 && rCn.text === '中文内容测试',
    `PUT HTTP ${r.status}, GET "${rCn.text}"`
  );

  // ---------------- 8. PROPFIND 子目录（检查 size/etag） ----------------
  r = await req('PROPFIND', '/sub', { headers: { Depth: '1' } });
  const hasSize = /<D:getcontentlength>\d+<\/D:getcontentlength>/.test(r.text);
  const hasEtag = /<D:getetag>"/.test(r.text);
  const hasColl = /<D:collection\/>/.test(r.text);
  const noNeg = !/getcontentlength>-1</.test(r.text);
  record(
    'PROPFIND /sub 元数据完整',
    r.status === 207 && hasSize && hasEtag && noNeg,
    `size=${hasSize} etag=${hasEtag} 无负长度=${noNeg}`
  );

  // ---------------- 9. COPY ----------------
  r = await req('COPY', '/sub/hello.txt', {
    headers: { Destination: base + '/sub/copied.txt', Overwrite: 'T' },
  });
  const rCopy = await req('GET', '/sub/copied.txt');
  record(
    'COPY /sub/hello.txt -> /sub/copied.txt',
    [200, 201, 204].includes(r.status) && rCopy.text === 'v2-overwritten',
    `HTTP ${r.status}, 副本内容 "${rCopy.text}"`
  );

  // ---------------- 10. MOVE（跨目录 + 改名） ----------------
  r = await req('MOVE', '/sub/copied.txt', {
    headers: { Destination: base + '/moved.txt', Overwrite: 'T' },
  });
  const rMoved = await req('GET', '/moved.txt');
  const rGone = await req('GET', '/sub/copied.txt');
  record(
    'MOVE /sub/copied.txt -> /moved.txt',
    [200, 201, 204].includes(r.status) && rMoved.text === 'v2-overwritten' && rGone.status === 404,
    `HTTP ${r.status}, 目标 "${rMoved.text}", 源 HTTP ${rGone.status}`
  );

  // ---------------- 10b. MOVE 同目录改名（最容易踩坑的路径） ----------------
  const ren = Buffer.from('same-dir-rename-payload', 'utf8');
  await req('PUT', '/sub/ren-a.txt', {
    headers: { 'Content-Length': String(ren.length) },
    body: ren,
  });
  r = await req('MOVE', '/sub/ren-a.txt', {
    headers: { Destination: base + '/sub/ren-b.txt', Overwrite: 'T' },
  });
  const rRen = await req('GET', '/sub/ren-b.txt');
  const rRenOld = await req('GET', '/sub/ren-a.txt');
  record(
    'MOVE 同目录改名 /sub/ren-a.txt -> /sub/ren-b.txt',
    [200, 201, 204].includes(r.status) &&
      rRen.text === 'same-dir-rename-payload' &&
      rRenOld.status === 404,
    `HTTP ${r.status}, 新名内容 "${rRen.text}", 旧名 HTTP ${rRenOld.status}`
  );

  // ---------------- 10c. COPY 覆盖已存在目标 ----------------
  const cpSrc = Buffer.from('copy-source-payload', 'utf8');
  await req('PUT', '/sub/cp-src.txt', {
    headers: { 'Content-Length': String(cpSrc.length) },
    body: cpSrc,
  });
  await req('PUT', '/sub/cp-dst.txt', {
    headers: { 'Content-Length': '3' },
    body: Buffer.from('old'),
  });
  r = await req('COPY', '/sub/cp-src.txt', {
    headers: { Destination: base + '/sub/cp-dst.txt', Overwrite: 'T' },
  });
  const rCpDst = await req('GET', '/sub/cp-dst.txt');
  const rCpSrc = await req('GET', '/sub/cp-src.txt');
  record(
    'COPY 覆盖已存在目标 /sub/cp-src.txt -> /sub/cp-dst.txt',
    [200, 201, 204].includes(r.status) &&
      rCpDst.text === 'copy-source-payload' &&
      rCpSrc.text === 'copy-source-payload',
    `HTTP ${r.status}, 目标 "${rCpDst.text}", 源仍在 "${rCpSrc.text}"`
  );

  // ---------------- 11. DELETE 文件 ----------------
  r = await req('DELETE', '/moved.txt');
  const rDel = await req('GET', '/moved.txt');
  record(
    'DELETE /moved.txt',
    [200, 204].includes(r.status) && rDel.status === 404,
    `HTTP ${r.status}, 再 GET HTTP ${rDel.status}`
  );

  // ---------------- 12. DELETE 非空目录（递归） ----------------
  r = await req('DELETE', '/sub');
  const rSub = await req('PROPFIND', '/sub', { headers: { Depth: '0' } });
  record(
    'DELETE /sub（含大文件，递归）',
    [200, 204].includes(r.status) && rSub.status === 404,
    `HTTP ${r.status}, 再 PROPFIND HTTP ${rSub.status}`
  );

  // ---------------- 13. 目录已清空 ----------------
  r = await req('PROPFIND', '/', { headers: { Depth: '1' } });
  const leftover = (r.text.match(/<D:href>/g) || []).length - 1; // 减掉根自己
  record('测试目录已清空', leftover === 0, `剩余 ${leftover} 项`);

  // ---------------- 缓存统计 ----------------
  console.log('');
  console.log(
    `API 调用 ${client.stats.apiCalls} 次 | 缓存命中 ${client.stats.cacheHits} | 未命中 ${client.stats.cacheMisses}`
  );
}

// ---------------------------------------------------------------- 收尾
async function cleanup() {
  if (server) {
    await new Promise((r) => server.stop(r)).catch(() => {});
    server = null;
  }
}

main()
  .catch((e) => {
    record('冒烟测试异常中断', false, e && e.message ? e.message : String(e));
    if (e && e.stack) console.error(e.stack);
  })
  .finally(async () => {
    await cleanup();

    const failed = results.filter((x) => !x.ok);
    console.log('');
    console.log('='.repeat(70));
    console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项:');
      for (const f of failed) console.log('  ❌ ' + f.name + ' — ' + f.detail);
    }
    console.log('='.repeat(70));
    console.log('');
    console.log('注意：测试目录 ' + ROOT + ' 本身需要单独删除（网关不允许删自己的根）：');
    console.log('  node "' + path.join(asy.ROOT, 'asy.js') + '" rm ' + ROOT);
    process.exit(failed.length ? 1 : 0);
  });
