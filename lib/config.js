// ============================================================================
// asy-webdav - 配置读写
// ----------------------------------------------------------------------------
// server.js 与 cli.js 共用，避免两边各写一份 defaults()。
// 配置文件位置由 lib/paths.js 决定（默认与包同目录，可用 ASY_WEBDAV_HOME 覆盖）。
// ============================================================================

'use strict';

const fs = require('fs');
const crypto = require('crypto');

const paths = require('./paths');

function defaults() {
  return {
    port: 1901,
    host: '127.0.0.1',
    // 想同时监听多个地址就填 hosts（优先级高于 host），例如：
    //   "hosts": ["127.0.0.1", "100.x.y.z"]   ← 本机 + Tailscale
    // 这样本机的 Zotero 和尾网里的设备都能连，而校园网 IP 上访问不到。
    hosts: [],
    username: 'webdav',
    password: '',
    remoteRoot: '/WebDAV/SyncDisk',
    cacheTtlMs: 15000,
    apiConcurrency: 4,
    // 上传重名策略。实测语义（scripts/probe-ondup.js 验证过）：
    //   1=拒绝同名  2=保留两者(自动改名)  3=覆盖
    // WebDAV 的 PUT 语义就是覆盖，所以默认 3。
    ondup: 3,
    debug: false,
    // 本服务独立使用的 asy-cli 凭据目录（绝对路径）。
    // 作为系统服务运行时「没有用户配置文件」，必须写死绝对路径，
    // 否则 os.homedir() 会指向系统目录而找不到凭据。
    asyConfigDir: '',
  };
}

/** 配置里允许被 config set 修改的键 */
const EDITABLE = Object.keys(defaults());

function load() {
  if (!fs.existsSync(paths.CONFIG_PATH)) return defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(paths.CONFIG_PATH, 'utf8'));
    return Object.assign(defaults(), raw);
  } catch (e) {
    const err = new Error('配置文件解析失败（' + paths.CONFIG_PATH + '）：' + e.message);
    err.code = 'EBADCONFIG';
    throw err;
  }
}

/**
 * 读取配置；不存在则生成一份带随机密码的。
 * @returns {{cfg: object, created: boolean}}
 */
function loadOrCreate() {
  if (fs.existsSync(paths.CONFIG_PATH)) return { cfg: load(), created: false };

  const cfg = defaults();
  cfg.password = crypto.randomBytes(9).toString('base64url');
  paths.ensureHome();
  save(cfg);
  return { cfg, created: true };
}

function save(cfg) {
  paths.ensureHome();
  fs.writeFileSync(paths.CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return paths.CONFIG_PATH;
}

/** 解析出要监听的地址列表。hosts 非空时以它为准，否则退回单个 host。 */
function resolveHosts(cfg) {
  const list = Array.isArray(cfg.hosts)
    ? cfg.hosts.filter((h) => typeof h === 'string' && h.trim())
    : [];
  const hosts = list.length ? list.map((h) => h.trim()) : [cfg.host || '127.0.0.1'];
  // 去重（保序）
  return hosts.filter((h, i) => hosts.indexOf(h) === i);
}

module.exports = { defaults, load, loadOrCreate, save, resolveHosts, EDITABLE };
