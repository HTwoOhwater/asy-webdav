// ============================================================================
// asy-webdav - AnyShare 云盘 WebDAV 网关
// ----------------------------------------------------------------------------
// 直接用 asy-cli 的云盘 API 提供 WebDAV 服务：不装官方客户端、不需要本地同步盘。
//
//   Zotero / Obsidian ──WebDAV──▶ 本服务 ──AnyShare HTTP API──▶ 山大云盘
//
// 配置：位置由 lib/paths.js 决定（默认与包同目录，可用 ASY_WEBDAV_HOME 覆盖）
//   port            监听端口
//   host            监听地址（默认 127.0.0.1）
//   hosts           要监听的多个地址（优先级高于 host）。例如同时监听本机与 Tailscale：
//                     "hosts": ["127.0.0.1", "100.x.y.z"]
//                   这样本机客户端和尾网设备都能连，而校园网 IP 上访问不到。
//   username/password  WebDAV Basic 认证
//   remoteRoot      WebDAV 的 "/" 映射到云盘的哪个目录，如 /WebDAV/SyncDisk
//   cacheTtlMs      目录列举缓存有效期（毫秒），越大越省 API 调用
//   apiConcurrency  同时最多几个云盘 API 请求
//   apiTimeoutMs    单次云盘 API 请求超时（毫秒）
//   apiReadRetries  只读请求失败后的重试次数（写请求永不自动重试）
//   ondup           上传重名策略：1=拒绝同名 2=保留两者 3=覆盖（默认 3）
//   debug           打印每次云盘 API 调用
//   asyConfigDir    本服务独立使用的 asy-cli 凭据目录（强烈建议设置，见 README）
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const { v2: webdav } = require('webdav-server');
const asy = require('./lib/asy-cli');
const paths = require('./lib/paths');
const configLib = require('./lib/config');
const { AnyShareClient } = require('./lib/client');
const { AnyShareFileSystem } = require('./lib/anyshare-fs');
const { MetadataStore, ContentCache } = require('./lib/cache');

// ---------------------------------------------------------------- 配置
const { cfg: config, created } = configLib.loadOrCreate();
if (created) {
  console.log('='.repeat(64));
  console.log('【首次运行】已生成 config.json（含随机密码）：');
  console.log('  位置       : ' + paths.CONFIG_PATH);
  console.log('  端口       : ' + config.port);
  console.log('  用户名     : ' + config.username);
  console.log('  密码       : ' + config.password);
  console.log('  云端根目录 : ' + config.remoteRoot);
  console.log('  >> 请按需修改（尤其是 remoteRoot 与密码），然后重启本服务。');
  console.log('='.repeat(64));
}
const resolveHosts = configLib.resolveHosts;

// ---------------------------------------------------------------- 日志
function makeLogger(debug) {
  return (level, msg) => {
    if (level === 'debug' && !debug) return;
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
  };
}
const log = makeLogger(config.debug);

// ---------------------------------------------------------------- asy-cli 凭据
if (config.asyConfigDir) {
  process.env.ASY_CONFIG_DIR = path.resolve(config.asyConfigDir);
}
const asyCfg = asy.config.load();
if (!asyCfg.refreshToken) {
  console.error('❌ 未找到 asy-cli 登录凭据，请先登录：');
  console.error('   node "' + path.join(asy.ROOT, 'asy.js') + '" login --cas');
  console.error('   凭据目录: ' + asy.config.CONFIG_DIR);
  process.exit(1);
}
console.log('asy-cli  : ' + asy.ROOT);
console.log('凭据目录 : ' + asy.config.CONFIG_DIR);
console.log('云盘实例 : ' + asyCfg.baseUrl);
console.log('账号     : ' + (asyCfg.rootName || '(未记录)'));
if (!config.asyConfigDir) {
  console.log('');
  console.log('⚠️  未设置 asyConfigDir：本服务与 asy-cli 命令行共用同一份凭据。');
  console.log('    refresh_token 会轮换，两边同时刷新可能互相踢下线。');
  console.log('    建议在 config.json 里设置 asyConfigDir 并单独登录一次。');
  console.log('');
}

// ---------------------------------------------------------------- 文件系统
const metadataStore = new MetadataStore(paths.METADATA_CACHE_PATH, config.metadataCacheTtlMs, log);
const contentCache = new ContentCache(paths.CONTENT_CACHE_DIR, config.contentCacheMaxBytes, log);
const client = new AnyShareClient({
  cfg: asyCfg,
  basePath: config.remoteRoot,
  ttlMs: config.cacheTtlMs,
  concurrency: config.apiConcurrency,
  timeoutMs: config.apiTimeoutMs,
  readRetries: config.apiReadRetries,
  debug: config.debug,
  log,
  metadataStore,
});

const vfs = new AnyShareFileSystem(client, {
  ondup: config.ondup,
  log,
  contentCache,
});

// ---------------------------------------------------------------- 认证
const userManager = new webdav.SimpleUserManager();
const user = userManager.addUser(config.username, config.password, false);
const privilegeManager = new webdav.SimplePathPrivilegeManager();
privilegeManager.setRights(user, '/', ['all']);
const httpAuthentication = new webdav.HTTPBasicAuthentication(userManager, 'asy-webdav');

// ---------------------------------------------------------------- 服务器
const server = new webdav.WebDAVServer({
  port: config.port,
  hostname: config.host,
  httpAuthentication,
  privilegeManager,
  requireAuthentification: true,
});

// 访问日志（排查 Zotero/Obsidian 连接问题用）
const ACCESS_LOG = paths.ACCESS_LOG;
server.afterManagers.push((ctx, next) => {
  try {
    const who = (ctx.user && (ctx.user.uid || ctx.user.name)) || 'anonymous';
    const ip = (ctx.request && ctx.request.socket && ctx.request.socket.remoteAddress) || '-';
    const line = [
      new Date().toISOString(),
      ctx.request.method,
      ctx.request.url,
      ctx.response.statusCode,
      who,
      ip,
    ].join(' | ');
    fs.appendFile(ACCESS_LOG, line + '\n', () => {});
  } catch {
    /* 日志失败不影响服务 */
  }
  next();
});

// ---------------------------------------------------------------- 启动
async function main() {
  // 先解析云端根目录：配置错了就在这里失败，而不是等 Zotero 报错
  let root;
  try {
    root = await client.rootEntry();
  } catch (e) {
    console.error('❌ 无法解析云端根目录 "' + config.remoteRoot + '"：' + e.message);
    console.error('   检查 config.json 的 remoteRoot，以及 token 是否还有效（asy whoami）。');
    process.exit(1);
  }

  let childCount = 0;
  try {
    const map = await client.listDir('/');
    childCount = map ? map.size : 0;
  } catch {
    /* 只读探测失败不影响启动 */
  }

  server.setFileSystem('/', vfs, (ok) => {
    if (!ok) {
      console.error('❌ 挂载文件系统失败');
      process.exit(1);
    }
    startListeners((err) => {
      if (err) {
        console.error('❌ 监听失败: ' + err.message);
        process.exit(1);
      }
      console.log('');
      console.log('✅ AnyShare WebDAV 网关已启动');
      console.log('   监听地址 : ' + listeners.map((l) => `${l.host}:${config.port}`).join('  ,  '));
      for (const l of listeners) {
        console.log('              http://' + l.host + ':' + config.port + '/');
      }
      console.log('   用户名   : ' + config.username);
      console.log('   密码     : ' + config.password);
      console.log('   云端根   : ' + config.remoteRoot + '  (' + root.docid + ')');
      console.log('   根目录子项: ' + childCount + ' 个');
      console.log('');
      const first = 'http://' + listeners[0].host + ':' + config.port;
      console.log('   Zotero   : ' + first + '/zotero');
      console.log('   Obsidian : ' + first + '/obsidian/<你的 vault 目录>');
      console.log('');
      console.log('   缓存 TTL : ' + config.cacheTtlMs + ' ms    API 并发: ' + config.apiConcurrency);
      console.log(
        '   元数据缓存: ' + config.metadataCacheTtlMs + ' ms    内容缓存上限: ' +
          config.contentCacheMaxBytes + ' B'
      );
      console.log('   按 Ctrl+C 停止。');
    });
  });
}

// ---------------------------------------------------------------- 监听
// 不走 server.start()，因为那样只能绑一个地址。这里为每个地址各建一个
// http.Server，复用同一个 WebDAVServer 实例的请求处理器。
const listeners = [];
function startListeners(callback) {
  const hosts = resolveHosts(config);
  let pending = hosts.length;
  let failed = false;

  for (const host of hosts) {
    const srv = http.createServer((req, res) => server.executeRequest(req, res));
    srv.on('error', (e) => {
      if (failed) return;
      failed = true;
      callback(e);
    });
    srv.listen(config.port, host, () => {
      listeners.push({ host, server: srv });
      if (--pending === 0 && !failed) callback(null);
    });
  }

  // 让 server.stop() 之类的外部调用仍能工作（指向第一个监听器）
  Object.defineProperty(server, 'server', {
    get: () => (listeners[0] ? listeners[0].server : null),
    configurable: true,
  });
}

// ---------------------------------------------------------------- 退出
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n正在停止服务...');
  console.log(
    `API 调用 ${client.stats.apiCalls} 次，重试 ${client.stats.retries} 次，` +
      `合并 ${client.stats.coalesced} 次，缓存命中 ${client.stats.cacheHits} 次，` +
      `未命中 ${client.stats.cacheMisses} 次，持久化命中 ${client.stats.persistentHits} 次，` +
      `过期兜底 ${client.stats.staleFallbacks} 次；内容命中 ${contentCache.stats.hits} 次`
  );
  for (const l of listeners) {
    try {
      l.server.close();
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('❌ 启动失败: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
