// ============================================================================
// asy-webdav - 配置模块测试
// ----------------------------------------------------------------------------
// ⚠️ 本文件会调用 configLib.loadOrCreate()，它会**写** config.json。
//    所以必须在任何 require 之前把 ASY_WEBDAV_HOME 指到临时目录，
//    并且用一个「安全闸」测试确认它真的生效 —— 否则就会覆盖开发机上
//    正在用的真实配置（含密码）。
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asy-webdav-cfgtest-'));
process.env.ASY_WEBDAV_HOME = TMP;

const test = require('node:test');
const assert = require('node:assert');

const paths = require('../lib/paths');
const configLib = require('../lib/config');

process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

// ---------------------------------------------------------------- 安全闸
test('安全闸：运行目录必须落在临时目录内', () => {
  const tmpReal = fs.realpathSync(os.tmpdir());
  const homeReal = fs.existsSync(paths.HOME) ? fs.realpathSync(paths.HOME) : paths.HOME;
  assert.ok(
    homeReal.startsWith(tmpReal),
    'ASY_WEBDAV_HOME 未生效！HOME=' +
      paths.HOME +
      '\n拒绝继续执行，否则会覆盖真实的 config.json。'
  );
});

// ---------------------------------------------------------------- 核心回归
test('loadOrCreate：首次生成非空随机密码（回归：曾经生成空密码）', () => {
  const { cfg, created } = configLib.loadOrCreate();
  assert.strictEqual(created, true, '第一次调用应报告 created=true');
  assert.ok(
    typeof cfg.password === 'string' && cfg.password.length >= 12,
    '密码必须非空且足够长，实际: ' + JSON.stringify(cfg.password)
  );
  assert.ok(fs.existsSync(paths.CONFIG_PATH), 'config.json 应已落盘');
});

test('loadOrCreate：已存在时不重复创建，密码保持稳定', () => {
  const before = configLib.load().password;
  const { created } = configLib.loadOrCreate();
  assert.strictEqual(created, false);
  assert.strictEqual(configLib.load().password, before, '不应重新生成密码');
});

test('load：文件缺失时返回默认值且 password 为空 —— 所以绝不能直接 save', () => {
  fs.unlinkSync(paths.CONFIG_PATH);
  const cfg = configLib.load();
  assert.strictEqual(cfg.password, '', '这正是「空密码漏洞」的根源，必须由 loadOrCreate 兜住');
  assert.strictEqual(cfg.port, 1901);
  assert.deepStrictEqual(cfg.hosts, []);
});

test('loadOrCreate：从「文件缺失」状态恢复时也会补上密码', () => {
  // 上一个测试把文件删了，这里模拟新机器上先跑 config set 的场景
  const { cfg, created } = configLib.loadOrCreate();
  assert.strictEqual(created, true);
  assert.ok(cfg.password.length >= 12);
});

// ---------------------------------------------------------------- 往返
test('save / load 往返保持数据', () => {
  const cfg = configLib.loadOrCreate().cfg;
  cfg.port = 18888;
  cfg.hosts = ['127.0.0.1', '100.64.0.1'];
  configLib.save(cfg);

  const back = configLib.load();
  assert.strictEqual(back.port, 18888);
  assert.deepStrictEqual(back.hosts, ['127.0.0.1', '100.64.0.1']);
  assert.strictEqual(back.password, cfg.password);
});

test('load：配置损坏时抛出 EBADCONFIG 而不是静默用默认值', () => {
  fs.writeFileSync(paths.CONFIG_PATH, '{ 这不是合法 JSON', 'utf8');
  assert.throws(() => configLib.load(), (e) => e.code === 'EBADCONFIG');
});

test('load：部分字段缺失时用默认值补齐', () => {
  fs.writeFileSync(paths.CONFIG_PATH, JSON.stringify({ port: 1999 }), 'utf8');
  const cfg = configLib.load();
  assert.strictEqual(cfg.port, 1999);
  assert.strictEqual(cfg.remoteRoot, '/WebDAV/SyncDisk', '缺失字段应回落到默认值');
  assert.strictEqual(cfg.username, 'webdav');
  assert.strictEqual(cfg.metadataCacheTtlMs, 300000);
  assert.strictEqual(cfg.contentCacheMaxBytes, 1073741824);
});
