// ============================================================================
// asy-webdav - 只读查看器
// ----------------------------------------------------------------------------
// 把网关挂到任意云端目录，只做 PROPFIND / GET，不写任何东西。
// 用来确认「真实在用的目录」能不能被正确读出来（比如 Zotero/Obsidian 的数据）。
//
//   node scripts/peek.js --root /WebDAV/SyncDisk --port 1903
//   node scripts/peek.js --root /WebDAV/SyncDisk --get "/同步测试.txt"
// ============================================================================

'use strict';

const net = require('net');
const { v2: webdav } = require('webdav-server');

const asy = require('../lib/asy-cli');
const { AnyShareClient } = require('../lib/client');
const { AnyShareFileSystem } = require('../lib/anyshare-fs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = arg('root', '/WebDAV/SyncDisk');
const PORT = Number(arg('port', '1903'));
const GET = arg('get', '');
const USER = 'webdav';
const PASS = 'peek-only';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 从 multistatus XML 里抠出 href + 是否 collection + 长度 */
function parseMultiStatus(xml) {
  const out = [];
  const blocks = xml.split(/<D:response>/).slice(1);
  for (const b of blocks) {
    const href = (/<D:href>([^<]*)<\/D:href>/.exec(b) || [])[1] || '';
    const isDir = /<D:collection\/>/.test(b);
    const size = (/<D:getcontentlength>(\d+)<\/D:getcontentlength>/.exec(b) || [])[1];
    const mtime = (/<D:getlastmodified>([^<]*)<\/D:getlastmodified>/.exec(b) || [])[1] || '';
    const etag = (/<D:getetag>([^<]*)<\/D:getetag>/.exec(b) || [])[1] || '';
    out.push({ href: decodeURIComponent(href), isDir, size, mtime, etag });
  }
  return out;
}

async function main() {
  const cfg = asy.config.load();
  const client = new AnyShareClient({ cfg, basePath: ROOT, ttlMs: 5000, concurrency: 3 });
  const vfs = new AnyShareFileSystem(client, {
    log: (level, msg) => {
      if (level === 'error') console.error('[fs] ' + msg);
    },
  });

  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser(USER, PASS, false);
  const privilegeManager = new webdav.SimplePathPrivilegeManager();
  privilegeManager.setRights(user, '/', ['all']);

  const port = PORT || (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

  const server = new webdav.WebDAVServer({
    port,
    hostname: '127.0.0.1',
    httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'asy-webdav-peek'),
    privilegeManager,
    requireAuthentification: true,
  });
  await new Promise((resolve, reject) => {
    server.setFileSystem('/', vfs, (ok) => (ok ? server.start(resolve) : reject(new Error('挂载失败'))));
  });

  console.log('挂载云端目录: ' + ROOT);
  console.log('WebDAV 地址 : ' + base + '/  (只读查看，不会写入)');
  console.log('');

  try {
    const res = await fetch(base + '/', {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
    });
    const xml = await res.text();
    const items = parseMultiStatus(xml);
    console.log(`PROPFIND / Depth:1 -> HTTP ${res.status}，${items.length - 1} 个子项`);
    console.log('-'.repeat(72));
    for (const it of items.slice(1)) {
      const kind = it.isDir ? '[D]' : '[F]';
      const size = it.isDir ? '' : `${it.size} B`;
      console.log(`${kind} ${it.href.padEnd(52)} ${size.padStart(10)}  ${it.mtime}`);
    }

    if (GET) {
      console.log('');
      const g = await fetch(base + GET, { headers: { Authorization: auth } });
      const buf = Buffer.from(await g.arrayBuffer());
      console.log(`GET ${GET} -> HTTP ${g.status}, Content-Length ${g.headers.get('content-length')}, 实收 ${buf.length} B`);
      console.log('前 200 字节: ' + JSON.stringify(buf.toString('utf8').slice(0, 200)));
    }
  } finally {
    await new Promise((r) => server.stop(r));
  }
}

main().catch((e) => {
  console.error('失败: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
