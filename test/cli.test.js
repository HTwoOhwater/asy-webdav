// ============================================================================
// asy-webdav - CLI 与平台适配的单元测试（纯函数，不碰网络与系统）
// 运行: node --test test/cli.test.js
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseArgs, dispWidth, padLabel, validateHosts, candidateAddresses } = require('../cli');
const service = require('../lib/service');
const configLib = require('../lib/config');
const paths = require('../lib/paths');

// ---------------------------------------------------------------- parseArgs
test('parseArgs: 位置参数', () => {
  const a = parseArgs(['start']);
  assert.deepStrictEqual(a._, ['start']);
  assert.deepStrictEqual(a.flags, {});
});

test('parseArgs: 短选项带值（-n 5）', () => {
  const a = parseArgs(['logs', '-n', '5']);
  assert.deepStrictEqual(a._, ['logs']);
  assert.strictEqual(a.flags.n, '5');
});

test('parseArgs: 长选项带值', () => {
  const a = parseArgs(['service', 'install', '--home', 'C:\\data']);
  assert.strictEqual(a.flags.home, 'C:\\data');
  assert.deepStrictEqual(a._, ['service', 'install']);
});

test('parseArgs: 布尔开关（--boot / -f / --no-probe）', () => {
  const a = parseArgs(['status', '--no-probe', '-f', '--boot']);
  assert.strictEqual(a.flags['no-probe'], true);
  assert.strictEqual(a.flags.f, true);
  assert.strictEqual(a.flags.boot, true);
});

test('parseArgs: 布尔开关后面跟另一个开关时不吃掉它', () => {
  const a = parseArgs(['service', 'install', '--boot', '--system']);
  assert.strictEqual(a.flags.boot, true);
  assert.strictEqual(a.flags.system, true);
});

test('parseArgs: 负数不会被当成选项', () => {
  const a = parseArgs(['config', 'set', 'cacheTtlMs', '-1']);
  assert.deepStrictEqual(a._, ['config', 'set', 'cacheTtlMs', '-1']);
  assert.deepStrictEqual(a.flags, {});
});

// ---------------------------------------------------------------- 终端排版
test('dispWidth: 中文按双宽计算', () => {
  assert.strictEqual(dispWidth('abc'), 3);
  assert.strictEqual(dispWidth('中文'), 4);
  assert.strictEqual(dispWidth('a中'), 3);
});

test('padLabel: 中英文混排后宽度一致', () => {
  assert.strictEqual(dispWidth(padLabel('状态', 13)), 13);
  assert.strictEqual(dispWidth(padLabel('access_token', 13)), 13);
});

// ---------------------------------------------------------------- 监听地址校验
test('validateHosts: 拒绝网段（CIDR）—— listen() 会 ENOTFOUND', () => {
  const { errors, warnings } = validateHosts(['100.64.0.0/10']);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('网段'));
  assert.strictEqual(warnings.length, 0, '网段属于硬错误，不该只给警告');
});

test('validateHosts: 回环地址合法且无警告', () => {
  const { errors, warnings } = validateHosts(['127.0.0.1', '::1', 'localhost']);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(warnings, []);
});

test('validateHosts: 不属于本机的地址只给警告（地址可能还没就绪）', () => {
  const { errors, warnings } = validateHosts(['203.0.113.7']);
  assert.deepStrictEqual(errors, [], '不该硬拦，否则 Tailscale 未启动时没法预先配置');
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('203.0.113.7'));
  assert.ok(warnings[0].includes('EADDRNOTAVAIL'));
});

test('validateHosts: 0.0.0.0 语法合法（虽然 README 不推荐）', () => {
  const { errors } = validateHosts(['0.0.0.0']);
  assert.deepStrictEqual(errors, []);
});

test('validateHosts: 一次报出多个问题', () => {
  const { errors } = validateHosts(['10.0.0.0/8', '192.168.1.0/24']);
  assert.strictEqual(errors.length, 2);
});

test('candidateAddresses: 不含回环与通配地址', () => {
  const c = candidateAddresses();
  for (const bad of ['127.0.0.1', '0.0.0.0', '::1', 'localhost', '::']) {
    assert.ok(!c.includes(bad), '不应包含 ' + bad);
  }
});

// ---------------------------------------------------------------- config
test('config: 默认值', () => {
  const d = configLib.defaults();
  assert.strictEqual(d.port, 1901);
  assert.strictEqual(d.host, '127.0.0.1');
  assert.deepStrictEqual(d.hosts, []);
  assert.strictEqual(d.ondup, 3);
  assert.strictEqual(d.asyConfigDir, '');
});

test('config: resolveHosts 优先用 hosts 并去重保序', () => {
  assert.deepStrictEqual(configLib.resolveHosts({ hosts: ['a', 'b', 'a'], host: 'x' }), ['a', 'b']);
});

test('config: resolveHosts 在 hosts 为空时退回 host', () => {
  assert.deepStrictEqual(configLib.resolveHosts({ hosts: [], host: '127.0.0.1' }), ['127.0.0.1']);
  assert.deepStrictEqual(configLib.resolveHosts({ hosts: ['  '], host: '10.0.0.1' }), ['10.0.0.1']);
});

test('config: resolveHosts 在 host 缺失时兜底 127.0.0.1', () => {
  assert.deepStrictEqual(configLib.resolveHosts({ hosts: [] }), ['127.0.0.1']);
});

test('config: EDITABLE 覆盖所有默认键', () => {
  assert.deepStrictEqual(configLib.EDITABLE.sort(), Object.keys(configLib.defaults()).sort());
  assert.ok(configLib.EDITABLE.includes('port'));
  assert.ok(configLib.EDITABLE.includes('asyConfigDir'));
});

// ---------------------------------------------------------------- paths
test('paths: 默认落在包目录', () => {
  assert.strictEqual(paths.CONFIG_PATH, path.join(paths.HOME, 'config.json'));
  assert.strictEqual(paths.PID_PATH, path.join(paths.HOME, 'server.pid'));
  assert.strictEqual(paths.ACCESS_LOG, path.join(paths.HOME, 'access.log'));
  assert.ok(paths.PKG_DIR.endsWith('asy-webdav'));
});

test('paths: userHomeDir 是绝对路径且以 asy-webdav 结尾', () => {
  const d = paths.userHomeDir();
  assert.ok(path.isAbsolute(d));
  assert.ok(/asy-webdav$/.test(d));
});

// ---------------------------------------------------------------- service: systemd
const SD_BASE = {
  nodePath: '/usr/bin/node',
  serverJs: '/opt/asy-webdav/server.js',
  home: '/home/me/.local/state/asy-webdav',
  asyConfigDir: '/home/me/.anyshare-cli',
  asyCliPath: '/opt/anyshare-university-cli',
  user: 'me',
};

test('systemd: 用户级单元不写 User=，且用 default.target', () => {
  const u = service.systemdUnit(Object.assign({}, SD_BASE, { system: false }));
  assert.ok(u.includes('ExecStart=/usr/bin/node /opt/asy-webdav/server.js'));
  assert.ok(u.includes('Environment=ASY_WEBDAV_HOME=/home/me/.local/state/asy-webdav'));
  assert.ok(u.includes('Environment=ASY_CONFIG_DIR=/home/me/.anyshare-cli'));
  assert.ok(u.includes('Environment=ASY_CLI_PATH=/opt/anyshare-university-cli'));
  assert.ok(u.includes('WantedBy=default.target'));
  assert.ok(!/^User=/m.test(u), '用户级单元不应包含 User=');
  assert.ok(u.includes('Restart=always'));
});

test('systemd: 系统级单元写 User= 且用 multi-user.target', () => {
  const u = service.systemdUnit(Object.assign({}, SD_BASE, { system: true }));
  assert.ok(u.includes('User=me'));
  assert.ok(u.includes('WantedBy=multi-user.target'));
});

test('systemd: 含空格的路径会被引号包起来', () => {
  const u = service.systemdUnit(
    Object.assign({}, SD_BASE, { home: '/home/me/my data', system: false })
  );
  assert.ok(u.includes('Environment="ASY_WEBDAV_HOME=/home/me/my data"'), u);
});

test('systemd: 没有凭据目录时不写 ASY_CONFIG_DIR', () => {
  const u = service.systemdUnit(Object.assign({}, SD_BASE, { asyConfigDir: '', system: false }));
  assert.ok(!u.includes('ASY_CONFIG_DIR'));
});

// ---------------------------------------------------------------- service: launchd
test('launchd: plist 结构完整', () => {
  const p = service.launchdPlist(Object.assign({}, SD_BASE, { system: false }));
  assert.ok(p.startsWith('<?xml version="1.0"'));
  assert.ok(p.includes('<key>Label</key>'));
  assert.ok(p.includes(service.LAUNCHD_LABEL));
  assert.ok(p.includes('<key>ProgramArguments</key>'));
  assert.ok(p.includes('<string>/usr/bin/node</string>'));
  assert.ok(p.includes('<key>EnvironmentVariables</key>'));
  assert.ok(p.includes('<key>ASY_WEBDAV_HOME</key>'));
  assert.ok(p.includes('<key>KeepAlive</key>'));
  // 标签闭合平衡（粗校验，防止生成出畸形 XML）
  const open = (p.match(/<dict>/g) || []).length;
  const close = (p.match(/<\/dict>/g) || []).length;
  assert.strictEqual(open, close);
});

test('launchd: XML 特殊字符被转义', () => {
  const p = service.launchdPlist(
    Object.assign({}, SD_BASE, { home: '/tmp/a&b<c>', system: false })
  );
  assert.ok(p.includes('a&amp;b&lt;c&gt;'));
  assert.ok(!p.includes('a&b<c>'));
});

// ---------------------------------------------------------------- service: Windows
test('windows: 包装脚本用 CRLF 且钉死绝对路径', () => {
  const w = service.windowsWrapper({
    nodePath: 'C:\\node\\node.exe',
    serverJs: 'C:\\app\\server.js',
    home: 'C:\\data',
    asyConfigDir: 'C:\\cred',
    asyCliPath: 'C:\\asy-cli',
  });
  assert.ok(w.includes('\r\n'), '必须是 CRLF，否则 cmd 解析可能出问题');
  assert.ok(w.includes('set "ASY_WEBDAV_HOME=C:\\data"'));
  assert.ok(w.includes('set "ASY_CONFIG_DIR=C:\\cred"'));
  assert.ok(w.includes('set "ASY_CLI_PATH=C:\\asy-cli"'));
  assert.ok(w.includes('"C:\\node\\node.exe" "C:\\app\\server.js"'));
  assert.ok(w.includes('@echo off'));
});

test('windows: 没有凭据目录时不写 ASY_CONFIG_DIR', () => {
  const w = service.windowsWrapper({
    nodePath: 'C:\\node\\node.exe',
    serverJs: 'C:\\app\\server.js',
    home: 'C:\\data',
    asyConfigDir: '',
    asyCliPath: '',
  });
  assert.ok(!w.includes('ASY_CONFIG_DIR'));
  assert.ok(!w.includes('ASY_CLI_PATH'));
});

// ---------------------------------------------------------------- service: planPaths
test('planPaths: 平台路径规划', () => {
  const p = service.planPaths({});
  assert.strictEqual(p.platform, process.platform);
  assert.ok(path.isAbsolute(p.home));
  assert.ok(path.isAbsolute(p.nodePath));
  assert.ok(p.serverJs.endsWith('server.js'));

  if (process.platform === 'win32') {
    assert.ok(p.wrapper.endsWith('service.cmd'));
    assert.strictEqual(p.taskName, service.SERVICE_NAME);
  } else if (process.platform === 'darwin') {
    assert.ok(p.plist.endsWith('.plist'));
  } else {
    assert.ok(p.unit.endsWith('asy-webdav.service'));
  }
});

test('planPaths: --home 覆盖运行目录', () => {
  const p = service.planPaths({ home: path.join(paths.PKG_DIR, 'tmp-home') });
  assert.strictEqual(p.home, path.join(paths.PKG_DIR, 'tmp-home'));
});
