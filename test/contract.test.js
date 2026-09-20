// ============================================================================
// asy-webdav - 端到端契约测试
// ----------------------------------------------------------------------------
// 用假云盘 + 假对象存储，跑一个真实的 webdav-server，发真实 HTTP 请求。
// 覆盖：PROPFIND / GET / HEAD / PUT(新建+覆盖) / MKCOL / DELETE(含递归)
//       / MOVE / COPY / 零字节上传 / 缓存命中
// 不需要学校账号，也不产生任何外网流量。
// ============================================================================

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { v2: webdav } = require('webdav-server');

const { startObjectStore, FakeApi } = require('./fake-cloud');
const { AnyShareClient } = require('../lib/client');
const { AnyShareFileSystem } = require('../lib/anyshare-fs');

const USER = 'webdav';
const PASS = 'test-pass';

let obj;
let api;
let client;
let server;
let base;
let auth;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function req(method, p, opts = {}) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ Authorization: auth }, opts.headers || {}),
    body: opts.body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf, text: buf.toString('utf8') };
}

before(async () => {
  obj = await startObjectStore();
  api = new FakeApi(obj.base, obj.store);

  // 预置一点内容：/zotero/ 目录 + 一个已有文件
  await api.mkdir(api.rootDocid, 'zotero');
  api.addFile('/zotero', 'old', 'old-content');

  client = new AnyShareClient({ api, basePath: '/', ttlMs: 60000, concurrency: 8 });
  const fsys = new AnyShareFileSystem(client, {
    log: (level, msg) => {
      if (level === 'error') console.error('[fs] ' + msg);
    },
  });

  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser(USER, PASS, false);
  const privilegeManager = new webdav.SimplePathPrivilegeManager();
  privilegeManager.setRights(user, '/', ['all']);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

  server = new webdav.WebDAVServer({
    port,
    hostname: '127.0.0.1',
    httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'asy-webdav-test'),
    privilegeManager,
    requireAuthentification: true,
  });

  await new Promise((resolve, reject) => {
    server.setFileSystem('/', fsys, (ok) => {
      if (!ok) return reject(new Error('setFileSystem 失败'));
      server.start(() => resolve());
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.stop(r));
  if (obj) await obj.close();
});

// ---------------------------------------------------------------- 认证
test('未认证请求被拒绝', async () => {
  const res = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '0' } });
  assert.strictEqual(res.status, 401);
});

// ---------------------------------------------------------------- PROPFIND
test('PROPFIND / Depth:1 返回目录与文件，且目录带 collection 标记', async () => {
  const r = await req('PROPFIND', '/', { headers: { Depth: '1' } });
  assert.strictEqual(r.status, 207);
  assert.match(r.text, /<D:multistatus/);
  assert.match(r.text, /zotero/);
  assert.match(r.text, /<D:collection\/>/);
  // 目录不能有 getcontentlength（云盘里 size 是 -1，必须归 0 而不是透传）
  assert.doesNotMatch(r.text, /getcontentlength>-1</);
});

test('PROPFIND 文件返回正确的 getcontentlength 与 getetag', async () => {
  const r = await req('PROPFIND', '/zotero/old', { headers: { Depth: '0' } });
  assert.strictEqual(r.status, 207);
  assert.match(r.text, /<D:getcontentlength>11<\/D:getcontentlength>/);
  assert.match(r.text, /<D:getetag>"rev/);
  assert.match(r.text, /<D:getlastmodified>/);
});

// ---------------------------------------------------------------- MKCOL
test('MKCOL 新建目录 -> 201，且云盘里真的建出来了', async () => {
  const r = await req('MKCOL', '/notes');
  assert.strictEqual(r.status, 201);
  assert.ok(api.nodeAt('/notes'), '云盘里应有 notes 目录');
});

test('MKCOL 重复建同名目录 -> 405/409', async () => {
  const r = await req('MKCOL', '/notes');
  assert.ok([405, 409].includes(r.status), `期望 405/409，实际 ${r.status}`);
});

// ---------------------------------------------------------------- PUT / GET
test('PUT 新文件 -> 201，内容与长度正确', async () => {
  const payload = Buffer.from('hello anyshare webdav');
  const r = await req('PUT', '/notes/a.txt', {
    headers: { 'Content-Length': String(payload.length) },
    body: payload,
  });
  assert.strictEqual(r.status, 201);

  const node = api.nodeAt('/notes/a.txt');
  assert.ok(node, '云盘里应有 a.txt');
  assert.strictEqual(node.size, payload.length);
  assert.strictEqual(obj.store.get(node.docid).toString(), 'hello anyshare webdav');
  assert.strictEqual(api.committed, node.docid, '必须调用过 osendupload');
});

test('GET 取回刚上传的文件，字节完全一致', async () => {
  const r = await req('GET', '/notes/a.txt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, 'hello anyshare webdav');
  assert.strictEqual(r.headers.get('content-length'), '21');
});

test('HEAD 返回正确的 Content-Length', async () => {
  const r = await req('HEAD', '/notes/a.txt');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-length'), '21');
});

test('PUT 覆盖已存在文件 -> 200，内容被替换（ondup=3 覆盖语义）', async () => {
  const payload = Buffer.from('v2');
  const r = await req('PUT', '/notes/a.txt', {
    headers: { 'Content-Length': '2' },
    body: payload,
  });
  assert.ok([200, 204].includes(r.status), `期望 200/204，实际 ${r.status}`);
  const node = api.nodeAt('/notes/a.txt');
  assert.strictEqual(node.size, 2);
  assert.strictEqual(obj.store.get(node.docid).toString(), 'v2');
});

test('PUT 零字节文件（Content-Length: 0，走临时文件中转退路）', async () => {
  const r = await req('PUT', '/notes/empty.txt', { headers: { 'Content-Length': '0' } });
  assert.ok([200, 201].includes(r.status), `期望 200/201，实际 ${r.status}`);
  const node = api.nodeAt('/notes/empty.txt');
  assert.ok(node, '云盘里应有 empty.txt');
  assert.strictEqual(node.size, 0);
});

test('PUT 中文文件名', async () => {
  const payload = Buffer.from('中文内容');
  const r = await req('PUT', '/notes/%E4%B8%AD%E6%96%87.txt', {
    headers: { 'Content-Length': String(payload.length) },
    body: payload,
  });
  assert.strictEqual(r.status, 201);
  const node = api.nodeAt('/notes/中文.txt');
  assert.ok(node, '云盘里应有中文.txt');
  assert.strictEqual(obj.store.get(node.docid).toString('utf8'), '中文内容');
});

// ---------------------------------------------------------------- COPY / MOVE
test('COPY 文件到新名字', async () => {
  const r = await req('COPY', '/notes/a.txt', {
    headers: { Destination: base + '/notes/b.txt', Overwrite: 'T' },
  });
  assert.ok([200, 201, 204].includes(r.status), `期望 2xx，实际 ${r.status}`);
  const b = api.nodeAt('/notes/b.txt');
  assert.ok(b, '云盘里应有 b.txt');
  assert.strictEqual(obj.store.get(b.docid).toString(), 'v2');
});

test('MOVE 文件到根目录并改名', async () => {
  const r = await req('MOVE', '/notes/b.txt', {
    headers: { Destination: base + '/moved.txt', Overwrite: 'T' },
  });
  assert.ok([200, 201, 204].includes(r.status), `期望 2xx，实际 ${r.status}`);
  assert.strictEqual(api.nodeAt('/notes/b.txt'), null, '源文件应已不存在');
  assert.ok(api.nodeAt('/moved.txt'), '目标应存在');
});

test('MOVE 到已存在目标且 Overwrite: F -> 412', async () => {
  await req('PUT', '/clash.txt', { headers: { 'Content-Length': '1' }, body: Buffer.from('x') });
  const r = await req('MOVE', '/moved.txt', {
    headers: { Destination: base + '/clash.txt', Overwrite: 'F' },
  });
  assert.strictEqual(r.status, 412);
});

test('MOVE 同目录改名（云盘 copy/move 不能指定新名字，最容易踩坑的路径）', async () => {
  const payload = Buffer.from('same-dir-rename');
  await req('PUT', '/ren-a.txt', {
    headers: { 'Content-Length': String(payload.length) },
    body: payload,
  });
  const r = await req('MOVE', '/ren-a.txt', {
    headers: { Destination: base + '/ren-b.txt', Overwrite: 'T' },
  });
  assert.ok([200, 201, 204].includes(r.status), `期望 2xx，实际 ${r.status}`);
  assert.strictEqual(api.nodeAt('/ren-a.txt'), null, '旧名字应消失');
  const got = await req('GET', '/ren-b.txt');
  assert.strictEqual(got.text, 'same-dir-rename', '改名后内容必须完好');
});

test('COPY 覆盖已存在目标（先删目标再复制）', async () => {
  const payload = Buffer.from('copy-source');
  await req('PUT', '/cp-src.txt', {
    headers: { 'Content-Length': String(payload.length) },
    body: payload,
  });
  await req('PUT', '/cp-dst.txt', { headers: { 'Content-Length': '3' }, body: Buffer.from('old') });
  const r = await req('COPY', '/cp-src.txt', {
    headers: { Destination: base + '/cp-dst.txt', Overwrite: 'T' },
  });
  assert.ok([200, 201, 204].includes(r.status), `期望 2xx，实际 ${r.status}`);
  const got = await req('GET', '/cp-dst.txt');
  assert.strictEqual(got.text, 'copy-source');
  const src = await req('GET', '/cp-src.txt');
  assert.strictEqual(src.text, 'copy-source', 'COPY 不能动到源文件');
});

// ---------------------------------------------------------------- DELETE
test('DELETE 文件 -> 2xx，云盘里消失', async () => {
  const r = await req('DELETE', '/moved.txt');
  assert.ok([200, 204].includes(r.status), `期望 200/204，实际 ${r.status}`);
  assert.strictEqual(api.nodeAt('/moved.txt'), null);
});

test('DELETE 非空目录 -> 递归删除成功', async () => {
  // notes 里还有 a.txt / empty.txt / 中文.txt，假 API 会拒绝直接删非空目录
  const r = await req('DELETE', '/notes');
  assert.ok([200, 204].includes(r.status), `期望 200/204，实际 ${r.status}`);
  assert.strictEqual(api.nodeAt('/notes'), null, 'notes 应被整个删掉');
  assert.strictEqual(api.nodeAt('/notes/a.txt'), null);
});

test('GET 不存在的路径 -> 404', async () => {
  const r = await req('GET', '/notes/a.txt');
  assert.strictEqual(r.status, 404);
});

test('DELETE WebDAV 根 -> 403（不允许删掉挂载点）', async () => {
  const r = await req('DELETE', '/');
  assert.strictEqual(r.status, 403);
});

// ---------------------------------------------------------------- 缓存
test('目录列举缓存生效：N 个子项的 PROPFIND 只打 1 次 sub_objects', async () => {
  // 建一个 6 个子项的目录
  await req('MKCOL', '/cache');
  for (let i = 0; i < 6; i++) {
    const b = Buffer.from('x' + i);
    await req('PUT', `/cache/f${i}.txt`, {
      headers: { 'Content-Length': String(b.length) },
      body: b,
    });
  }
  await req('PROPFIND', '/cache', { headers: { Depth: '1' } });
  const before = api.callsFor('sub_objects');

  for (let i = 0; i < 6; i++) {
    await req('PROPFIND', `/cache/f${i}.txt`, { headers: { Depth: '0' } });
  }
  const after = api.callsFor('sub_objects');
  assert.ok(after - before <= 1, `6 个子项应几乎不额外列举目录，实际多打了 ${after - before} 次`);
});

test('写操作会失效缓存：PUT 后立刻 PROPFIND 能看到新大小', async () => {
  const payload = Buffer.from('0123456789');
  await req('PUT', '/cache/fresh.txt', {
    headers: { 'Content-Length': String(payload.length) },
    body: payload,
  });
  const r = await req('PROPFIND', '/cache/fresh.txt', { headers: { Depth: '0' } });
  assert.match(r.text, /<D:getcontentlength>10<\/D:getcontentlength>/);
});
