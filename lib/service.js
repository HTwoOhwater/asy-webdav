// ============================================================================
// asy-webdav - 服务化（开机/登录自启）
// ----------------------------------------------------------------------------
// 设计原则：server.js 永远是一个普通的前台程序，完全不知道服务管理器存在。
// 所有平台差异都关在本文件里，按平台生成原生配置：
//
//   Linux   -> systemd unit（默认 --user，免 root；--system 则装到 /etc）
//   macOS   -> launchd plist（LaunchAgent 登录启动 / LaunchDaemon 开机启动）
//   Windows -> 一个 .cmd 包装脚本 + 任务计划程序任务
//              （登录触发免管理员；--boot 用 ONSTART + SYSTEM，需管理员）
//
// 生成的配置里会**写死绝对路径**，尤其是 ASY_CONFIG_DIR：
// 服务/计划任务在「没有加载用户配置文件」的环境下运行时，os.homedir()
// 会指向系统目录，不写死就找不到凭据文件。
//
// 生成函数都是纯函数，便于离线测试。
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const paths = require('./paths');

const SERVICE_NAME = 'asy-webdav';
const LAUNCHD_LABEL = 'com.asy-webdav.gateway';

// ---------------------------------------------------------------- 小工具
function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function isElevated() {
  if (process.platform === 'win32') {
    // `net session` 只有管理员才成功
    return run('net', ['session'], 5000).then((r) => r.ok);
  }
  return Promise.resolve(typeof process.getuid === 'function' && process.getuid() === 0);
}

function currentUser() {
  return process.env.USER || process.env.USERNAME || os.userInfo().username;
}

/** systemd 的值需要引号保护空格 */
function sdQuote(v) {
  return /[\s"']/.test(v) ? '"' + String(v).replace(/(["\\])/g, '\\$1') + '"' : String(v);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- 路径规划
function planPaths({ boot = false, system = false, home: homeOpt } = {}) {
  const home = homeOpt ? path.resolve(homeOpt) : paths.HOME;
  const nodePath = process.execPath;
  const serverJs = path.join(paths.PKG_DIR, 'server.js');
  const user = currentUser();

  if (process.platform === 'win32') {
    return {
      platform: 'win32',
      home,
      nodePath,
      serverJs,
      user,
      wrapper: path.join(home, 'service.cmd'),
      taskName: SERVICE_NAME,
      boot,
    };
  }

  if (process.platform === 'darwin') {
    const dir = system ? '/Library/LaunchDaemons' : path.join(os.homedir(), 'Library', 'LaunchAgents');
    return {
      platform: 'darwin',
      home,
      nodePath,
      serverJs,
      user,
      plist: path.join(dir, LAUNCHD_LABEL + '.plist'),
      system,
      boot: system || boot,
    };
  }

  const dir = system ? '/etc/systemd/system' : path.join(os.homedir(), '.config', 'systemd', 'user');
  return {
    platform: 'linux',
    home,
    nodePath,
    serverJs,
    user,
    unit: path.join(dir, SERVICE_NAME + '.service'),
    system,
    boot: system || boot,
  };
}

// ---------------------------------------------------------------- 生成器（纯函数）
/** Linux: systemd unit */
function systemdUnit({ nodePath, serverJs, home, asyConfigDir, asyCliPath, user, system, boot }) {
  const env = [
    `Environment=${sdQuote('ASY_WEBDAV_HOME=' + home)}`,
    asyConfigDir ? `Environment=${sdQuote('ASY_CONFIG_DIR=' + asyConfigDir)}` : null,
    asyCliPath ? `Environment=${sdQuote('ASY_CLI_PATH=' + asyCliPath)}` : null,
  ].filter(Boolean);

  const lines = [
    '# 由 asy-webdav 自动生成，请勿手工修改（重新执行 service install 会覆盖）',
    '[Unit]',
    'Description=AnyShare WebDAV gateway (asy-webdav)',
    'Documentation=https://github.com/HTwoOhwater/asy-webdav',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${sdQuote(nodePath)} ${sdQuote(serverJs)}`,
    'Restart=always',
    'RestartSec=3',
    ...env,
    'StandardOutput=journal',
    'StandardError=journal',
  ];
  // --user 单元由当前用户运行，不能再写 User=（systemd 会报错）
  if (system) lines.push(`User=${user}`);
  lines.push('', '[Install]', `WantedBy=${system ? 'multi-user.target' : 'default.target'}`, '');
  return lines.join('\n');
}

/** macOS: launchd plist */
function launchdPlist({ nodePath, serverJs, home, asyConfigDir, asyCliPath, system, boot }) {
  const env = [
    ['ASY_WEBDAV_HOME', home],
    asyConfigDir ? ['ASY_CONFIG_DIR', asyConfigDir] : null,
    asyCliPath ? ['ASY_CLI_PATH', asyCliPath] : null,
  ].filter(Boolean);

  const envXml = env
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 asy-webdav 自动生成，请勿手工修改 -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(serverJs)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(paths.PKG_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(home, 'server.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(home, 'server.err.log'))}</string>
</dict>
</plist>
`;
}

/** Windows: 包装脚本（把环境变量钉死，避免依赖用户配置文件） */
function windowsWrapper({ nodePath, serverJs, home, asyConfigDir, asyCliPath }) {
  const q = (s) => '"' + String(s) + '"';
  const lines = [
    '@echo off',
    'rem 由 asy-webdav 自动生成，请勿手工修改',
    'rem 作用：把绝对路径写死，这样任务计划程序在“不加载用户配置文件”',
    'rem 的情况下运行时也能找到配置和凭据。',
    'setlocal',
    `set "ASY_WEBDAV_HOME=${home}"`,
    asyConfigDir ? `set "ASY_CONFIG_DIR=${asyConfigDir}"` : null,
    asyCliPath ? `set "ASY_CLI_PATH=${asyCliPath}"` : null,
    `cd /d ${q(paths.PKG_DIR)}`,
    `${q(nodePath)} ${q(serverJs)} >> ${q(path.join(home, 'server.log'))} 2>> ${q(path.join(home, 'server.err.log'))}`,
    'endlocal',
    '',
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}

// ---------------------------------------------------------------- install
/**
 * @param {object} opts
 * @param {boolean} [opts.boot]    开机启动（Windows 需管理员；Linux 用户模式走 linger）
 * @param {boolean} [opts.system]  Linux/macOS 装成系统级（需 root）
 * @param {string}  [opts.asyConfigDir] asy-cli 凭据目录（绝对路径）
 * @param {string}  [opts.asyCliPath]   asy-cli 仓库根目录（绝对路径）
 * @param {boolean} [opts.dryRun]  只打印将要写入的内容，不落盘
 */
async function install(opts = {}) {
  const { boot = false, system = false, dryRun = false } = opts;
  const p = planPaths({ boot, system, home: opts.home });
  const asyConfigDir = opts.asyConfigDir ? path.resolve(opts.asyConfigDir) : '';
  const asyCliPath = opts.asyCliPath ? path.resolve(opts.asyCliPath) : '';

  const common = {
    nodePath: p.nodePath,
    serverJs: p.serverJs,
    home: p.home,
    asyConfigDir,
    asyCliPath,
    user: p.user,
    system: p.system,
    boot: p.boot,
  };

  const result = { platform: p.platform, boot: p.boot, system: !!p.system, actions: [], files: [], dryRun };

  if (p.platform === 'win32') {
    const content = windowsWrapper(common);
    result.files.push({ path: p.wrapper, content });
    if (dryRun) return result;

    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(p.wrapper, content, 'utf8');

    // 登录触发：不需要管理员；开机触发：ONSTART + SYSTEM，需要管理员
    const args = boot
      ? ['/Create', '/TN', p.taskName, '/TR', p.wrapper, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']
      : ['/Create', '/TN', p.taskName, '/TR', p.wrapper, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'];

    if (boot && !(await isElevated())) {
      const e = new Error(
        '开机启动（--boot）在 Windows 上需要管理员权限。\n' +
          '  请用「以管理员身份运行」的终端重试，或改用默认的登录启动。'
      );
      e.code = 'ENEEDADMIN';
      throw e;
    }

    const r = await run('schtasks', args);
    if (!r.ok) {
      const e = new Error('schtasks 创建任务失败：\n' + (r.stderr || r.stdout));
      e.code = 'ESCHTASKS';
      throw e;
    }
    result.actions.push(`已注册计划任务「${p.taskName}」（${boot ? '开机启动' : '登录启动'}）`);
    return result;
  }

  if (p.platform === 'darwin') {
    const content = launchdPlist(common);
    result.files.push({ path: p.plist, content });
    if (dryRun) return result;

    if (system && !(await isElevated())) {
      const e = new Error('系统级 LaunchDaemon 需要 root：请用 sudo 重试。');
      e.code = 'ENEEDADMIN';
      throw e;
    }
    fs.mkdirSync(p.home, { recursive: true });
    fs.mkdirSync(path.dirname(p.plist), { recursive: true });
    fs.writeFileSync(p.plist, content, 'utf8');
    const dom = system ? 'system' : `gui/${process.getuid()}`;
    await run('launchctl', ['bootout', dom, p.plist]);
    const r = await run('launchctl', ['bootstrap', dom, p.plist]);
    if (!r.ok) {
      const e = new Error('launchctl bootstrap 失败：\n' + (r.stderr || r.stdout));
      e.code = 'ELAUNCHCTL';
      throw e;
    }
    result.actions.push(`已注册 launchd（${system ? '系统级/开机' : '用户级/登录'}）`);
    return result;
  }

  // Linux / systemd
  const content = systemdUnit(common);
  result.files.push({ path: p.unit, content });
  if (dryRun) return result;

  if (system && !(await isElevated())) {
    const e = new Error('系统级 systemd 单元需要 root：请用 sudo 重试。');
    e.code = 'ENEEDADMIN';
    throw e;
  }

  fs.mkdirSync(p.home, { recursive: true });
  fs.mkdirSync(path.dirname(p.unit), { recursive: true });
  fs.writeFileSync(p.unit, content, 'utf8');

  const sysctl = system ? ['systemctl'] : ['systemctl', '--user'];
  await run(sysctl[0], sysctl.slice(1).concat(['daemon-reload']));
  const r = await run(sysctl[0], sysctl.slice(1).concat(['enable', SERVICE_NAME]));
  if (!r.ok) {
    const e = new Error('systemctl enable 失败：\n' + (r.stderr || r.stdout));
    e.code = 'ESYSTEMCTL';
    throw e;
  }
  result.actions.push(`已启用 systemd 单元 ${p.unit}`);

  if (boot && !system) {
    // 用户级单元要真正开机就跑，需要开启 linger
    const lr = await run('loginctl', ['enable-linger', p.user]);
    if (lr.ok) {
      result.actions.push(`已开启 linger（${p.user}），无需登录即可运行`);
    } else {
      result.warnings = result.warnings || [];
      result.warnings.push(
        '未能开启 linger（需要 root）：sudo loginctl enable-linger ' +
          p.user +
          '\n  未开启时，用户级服务只在你登录后才会启动。'
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------- uninstall
async function uninstall({ system = false, home: homeOpt } = {}) {
  const p = planPaths({ system, home: homeOpt });
  const result = { platform: p.platform, actions: [], removed: [] };

  if (p.platform === 'win32') {
    await run('schtasks', ['/End', '/TN', p.taskName]);
    const r = await run('schtasks', ['/Delete', '/TN', p.taskName, '/F']);
    if (r.ok) result.actions.push(`已删除计划任务「${p.taskName}」`);
    else result.actions.push('未找到计划任务（可能本来就没装）');
    try {
      fs.unlinkSync(p.wrapper);
      result.removed.push(p.wrapper);
    } catch {
      /* 不存在 */
    }
    return result;
  }

  if (p.platform === 'darwin') {
    const dom = system ? 'system' : `gui/${process.getuid()}`;
    await run('launchctl', ['bootout', dom, p.plist]);
    try {
      fs.unlinkSync(p.plist);
      result.removed.push(p.plist);
    } catch {
      /* 不存在 */
    }
    result.actions.push('已注销 launchd');
    return result;
  }

  const sysctl = system ? ['systemctl'] : ['systemctl', '--user'];
  await run(sysctl[0], sysctl.slice(1).concat(['disable', '--now', SERVICE_NAME]));
  try {
    fs.unlinkSync(p.unit);
    result.removed.push(p.unit);
  } catch {
    /* 不存在 */
  }
  await run(sysctl[0], sysctl.slice(1).concat(['daemon-reload']));
  result.actions.push('已停用并删除 systemd 单元');
  return result;
}

// ---------------------------------------------------------------- status
async function status({ system = false, home: homeOpt } = {}) {
  const p = planPaths({ system, home: homeOpt });
  const out = { platform: p.platform, installed: false, detail: '' };

  if (p.platform === 'win32') {
    const r = await run('schtasks', ['/Query', '/TN', p.taskName, '/FO', 'LIST', '/V']);
    out.installed = r.ok;
    if (r.ok) {
      const pick = (label) => {
        const m = r.stdout.match(new RegExp('^' + label + ':\\s*(.+)$', 'm'));
        return m ? m[1].trim() : '';
      };
      out.detail = [
        '计划任务 : ' + p.taskName,
        '状态     : ' + pick('Status'),
        '触发方式 : ' + pick('Schedule Type'),
        '下次运行 : ' + pick('Next Run Time'),
        '运行身份 : ' + pick('Run As User'),
      ].join('\n');
    }
    out.wrapper = p.wrapper;
    out.wrapperExists = fs.existsSync(p.wrapper);
    return out;
  }

  if (p.platform === 'darwin') {
    out.installed = fs.existsSync(p.plist);
    out.detail = out.installed ? 'plist: ' + p.plist : '';
    return out;
  }

  const sysctl = system ? ['systemctl'] : ['systemctl', '--user'];
  const en = await run(sysctl[0], sysctl.slice(1).concat(['is-enabled', SERVICE_NAME]));
  const ac = await run(sysctl[0], sysctl.slice(1).concat(['is-active', SERVICE_NAME]));
  out.installed = en.stdout.trim() === 'enabled';
  out.detail = [
    '单元文件 : ' + p.unit,
    'enabled  : ' + (en.stdout.trim() || '(未知)'),
    'active   : ' + (ac.stdout.trim() || '(未知)'),
  ].join('\n');
  return out;
}

module.exports = {
  SERVICE_NAME,
  LAUNCHD_LABEL,
  planPaths,
  systemdUnit,
  launchdPlist,
  windowsWrapper,
  install,
  uninstall,
  status,
  isElevated,
};
