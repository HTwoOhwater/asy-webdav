// ============================================================================
// asy-webdav - 路径解析
// ----------------------------------------------------------------------------
// 所有运行期文件（config.json / *.log / *.pid）的位置都在这里统一决定。
//
// 为什么需要集中管理：
//   * 装成全局 npm 包后，包目录可能在共享或只读位置，不该往里写东西；
//   * 作为系统服务 / 计划任务运行时「没有加载用户配置文件」，
//     os.homedir() 会指向 C:\Windows\System32\config\systemprofile 之类，
//     凭据和配置都会找不到。所以服务化时必须用环境变量把路径钉死。
//
// 可用环境变量（服务单元文件里会写入）：
//   ASY_WEBDAV_HOME    运行期目录（放 config.json / 日志 / pid）
//   ASY_WEBDAV_CONFIG  只覆盖 config.json 的路径
//   ASY_CONFIG_DIR     传给 asy-cli 的凭据目录（见 README「服务化」一节）
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 本包根目录 */
const PKG_DIR = path.join(__dirname, '..');

/** 运行期目录 */
function resolveHome() {
  if (process.env.ASY_WEBDAV_HOME) return path.resolve(process.env.ASY_WEBDAV_HOME);
  // 默认与包同目录 —— 保持与旧版本一致的行为
  return PKG_DIR;
}

const HOME = resolveHome();

const CONFIG_PATH = process.env.ASY_WEBDAV_CONFIG
  ? path.resolve(process.env.ASY_WEBDAV_CONFIG)
  : path.join(HOME, 'config.json');

const PID_PATH = path.join(HOME, 'server.pid');
const SERVER_LOG = path.join(HOME, 'server.log');
const ERR_LOG = path.join(HOME, 'server.err.log');
const ACCESS_LOG = path.join(HOME, 'access.log');
const CACHE_DIR = path.join(HOME, 'cache');
const METADATA_CACHE_PATH = path.join(CACHE_DIR, 'metadata.json');
const CONTENT_CACHE_DIR = path.join(CACHE_DIR, 'content');

/**
 * 平台默认的「用户级」运行目录，供 service install 使用。
 * 放在用户目录下而不是包目录，这样重装/升级包不会丢配置和日志。
 */
function userHomeDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'asy-webdav');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'asy-webdav');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'asy-webdav');
}

/** 确保运行期目录存在 */
function ensureHome(dir) {
  const d = dir || HOME;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  PKG_DIR,
  HOME,
  CONFIG_PATH,
  PID_PATH,
  SERVER_LOG,
  ERR_LOG,
  ACCESS_LOG,
  CACHE_DIR,
  METADATA_CACHE_PATH,
  CONTENT_CACHE_DIR,
  resolveHome,
  userHomeDir,
  ensureHome,
};
