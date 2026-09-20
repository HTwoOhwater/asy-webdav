// ============================================================================
// asy-webdav - asy-cli 装载器
// ----------------------------------------------------------------------------
// 复用 asy-cli（anyshare-university-cli）的 lib/，不复制它的代码：
//   lib/config.js   ~/.anyshare-cli/config.json 的读写（支持 ASY_CONFIG_DIR）
//   lib/api.js      AnyShareApi：efast 文件 API 客户端
//   lib/auth.js     token 自动续期
//   lib/transfer.js 单文件流式上传/下载 + authrequest 解析
//
// 查找顺序（可用环境变量 ASY_CLI_PATH 指定绝对路径）：
//   1. $ASY_CLI_PATH
//   2. <本仓库>/../asy-cli          （桌面上的同级目录，默认）
//   3. <本仓库>/node_modules/anyshare-university-cli
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

function looksLikeAsyCli(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, 'lib', 'api.js')) &&
      fs.existsSync(path.join(dir, 'lib', 'config.js')) &&
      fs.existsSync(path.join(dir, 'lib', 'transfer.js'))
    );
  } catch {
    return false;
  }
}

function resolveAsyCliRoot() {
  const candidates = [
    process.env.ASY_CLI_PATH,
    path.join(__dirname, '..', '..', 'asy-cli'),
    path.join(__dirname, '..', 'node_modules', 'anyshare-university-cli'),
  ].filter(Boolean);

  for (const c of candidates) {
    const abs = path.resolve(c);
    if (looksLikeAsyCli(abs)) return abs;
  }

  throw new Error(
    '找不到 asy-cli。请把它放在 ' +
      path.resolve(path.join(__dirname, '..', '..', 'asy-cli')) +
      ' ，或设置环境变量 ASY_CLI_PATH 指向仓库根目录。\n' +
      '  已尝试：\n' +
      candidates.map((c) => '    - ' + path.resolve(c)).join('\n')
  );
}

const ROOT = resolveAsyCliRoot();

const asyConfig = require(path.join(ROOT, 'lib', 'config.js'));
const asyApi = require(path.join(ROOT, 'lib', 'api.js'));
const asyTransfer = require(path.join(ROOT, 'lib', 'transfer.js'));

module.exports = {
  ROOT,
  config: asyConfig,
  AnyShareApi: asyApi.AnyShareApi,
  ApiError: asyApi.ApiError,
  TOKEN_EXPIRE_CODE: asyApi.TOKEN_EXPIRE_CODE,
  parseAuthEntries: asyTransfer.parseAuthEntries,
  uploadFile: asyTransfer.uploadFile,
};
