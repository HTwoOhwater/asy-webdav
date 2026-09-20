#!/usr/bin/env node
// ============================================================================
// asy-webdav - 命令行入口
// ----------------------------------------------------------------------------
// 分两层，互不依赖：
//   第一层  进程自管理：start / stop / restart / status / logs
//           靠 PID 文件 + 端口探测，三平台行为一致，不需要任何权限。
//   第二层  服务化：service install / uninstall / status
//           按平台生成原生配置（systemd / launchd / 任务计划程序）。
// server.js 始终是普通前台程序，完全不知道服务管理器存在。
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const paths = require('./lib/paths');
const configLib = require('./lib/config');
const daemon = require('./lib/daemon');
const serviceLib = require('./lib/service');

const VERSION = require('./package.json').version;

const HELP = `
asy-webdav ${VERSION} —— AnyShare WebDAV 网关

运行
  asy-webdav start [--foreground]     启动服务（默认后台运行）
  asy-webdav stop [--force]           停止服务
  asy-webdav restart                  重启服务
  asy-webdav status [--json] [--no-probe]
                                      查看状态（进程 / 端口 / 云端连通性）
  asy-webdav logs [--access|--err] [-f] [-n 30]
                                      查看日志（-f 持续跟踪，Ctrl+C 退出）

服务化（开机 / 登录自启）
  asy-webdav service install [--boot] [--system] [--home <目录>] [--dry-run]
  asy-webdav service uninstall [--system]
  asy-webdav service status

    默认    登录后启动，不需要管理员权限
    --boot  开机就启动。Windows 需管理员；Linux 用户级会自动开 linger
    --system 装成系统级服务（Linux / macOS 需要 sudo）
    --home  指定运行目录（放 config.json 与日志），默认与包同目录

后端登录
  asy-webdav login [--cas]            登录云盘。参数原样转发给 asy-cli，
                                      例如 asy-webdav login --cas
                                      （全局安装时 npm 不会提供 asy 命令，用这个）

配置
  asy-webdav config show              显示配置（密码打码）
  asy-webdav config set <键> <值>      修改配置
  asy-webdav config path              显示各文件位置

诊断
  asy-webdav doctor                   环境自检（换机器部署前先跑这个）

  --help / --version
`;

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 同时支持 --long 与 -s 短选项
    if (a.length > 1 && a.startsWith('-') && !/^-\d/.test(a)) {
      const key = a.startsWith('--') ? a.slice(2) : a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !(next.length > 1 && next.startsWith('-') && !/^-\d/.test(next))) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- 终端排版
// 中文是双宽字符，padEnd 按码点数补齐会让表格歪掉，这里按显示宽度补。
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padLabel(s, width) {
  return String(s) + ' '.repeat(Math.max(0, width - dispWidth(s)));
}

// ---------------------------------------------------------------- 小工具
const PF_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';

/** 向正在运行的服务发一个带认证的 PROPFIND，验证端到端可用 */
function probeWebdav(host, port, cfg, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const auth =
      'Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
    const req = http.request(
      {
        host,
        port,
        method: 'PROPFIND',
        path: '/',
        headers: {
          Authorization: auth,
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(PF_BODY),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: '超时' });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.end(PF_BODY);
  });
}

/** 尝试加载 asy-cli；失败不抛异常，交给调用方展示 */
function tryLoadAsy() {
  try {
    const asy = require('./lib/asy-cli');
    return { ok: true, root: asy.ROOT, configDir: asy.config.CONFIG_DIR, cfg: asy.config.load() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 读取配置；文件不存在就生成一份带随机密码的，并把密码打出来。
 *
 * ⚠️ 任何会**写**配置的地方都必须走这里，不能用 configLib.load()：
 * load() 在文件缺失时返回 defaults()，而 defaults().password 是空串，
 * 直接 save 就会生成一份「无密码」的配置 —— 服务随后以空密码对外提供
 * WebDAV（实测用 `webdav:` 空密码请求 PROPFIND 返回 207，能读能写）。
 */
function ensureConfig() {
  const { cfg, created } = configLib.loadOrCreate();
  if (created) {
    console.log('【首次运行】已生成 config.json');
    console.log('  位置   : ' + paths.CONFIG_PATH);
    console.log('  用户名 : ' + cfg.username);
    console.log('  密码   : ' + cfg.password);
    console.log('  >> WebDAV 客户端要用这组凭据；之后可用 asy-webdav config show 查看。');
    console.log('');
  }
  return cfg;
}

function localAddresses() {
  const set = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) set.add(ni.address);
  }
  return set;
}

function mask(v) {
  if (!v) return '(未设置)';
  return String(v).slice(0, 3) + '***(' + String(v).length + ' 位)';
}

function fmtHome() {
  return paths.HOME;
}

function insideNodeModules(p) {
  return /[\\/]node_modules[\\/]/.test(p);
}

function tokenLeft(asyCfg) {
  if (!asyCfg || !asyCfg.expiresAt) return null;
  return Math.round((asyCfg.expiresAt - Date.now()) / 60000);
}

function resolveServiceCreds() {
  const asy = tryLoadAsy();
  const cfg = configLib.load();
  const asyConfigDir = cfg.asyConfigDir
    ? path.resolve(cfg.asyConfigDir)
    : asy.ok
      ? asy.configDir
      : '';
  return { asy, cfg, asyConfigDir, asyCliPath: asy.ok ? asy.root : '' };
}

// ---------------------------------------------------------------- start
async function cmdStart(args) {
  const cfg = ensureConfig();
  const hosts = configLib.resolveHosts(cfg);

  if (!cfg.password) {
    console.warn('⚠️ config.json 里的 password 是空的 —— 任何人都能用空密码读写你的云盘！');
    console.warn('   请立刻设置：asy-webdav config set password <一个强密码>');
    console.warn('');
  }

  if (args.flags.foreground) {
    console.log('以前台方式启动（Ctrl+C 停止，不写 PID 文件）...');
    require(daemon.SERVER_JS); // server.js 会在本进程内启动
    return;
  }

  const r = await daemon.start({ hosts, port: cfg.port });
  console.log('✅ 服务已启动');
  console.log('   PID      : ' + r.pid);
  console.log('   监听地址 : ' + hosts.map((h) => h + ':' + cfg.port).join('  ,  '));
  for (const h of hosts) console.log('              http://' + h + ':' + cfg.port + '/');
  console.log('   日志     : ' + paths.SERVER_LOG);
  console.log('   停止     : asy-webdav stop');
}

// ---------------------------------------------------------------- stop
async function cmdStop(args) {
  const cfg = configLib.load();
  const hosts = configLib.resolveHosts(cfg);
  const r = await daemon.stop({ hosts, port: cfg.port, force: !!args.flags.force });
  if (r.stopped) console.log('✅ 已停止（PID ' + r.pid + '）');
  else console.log('服务本来就没在运行。');
}

// ---------------------------------------------------------------- restart
async function cmdRestart(args) {
  const cfg = configLib.load();
  const hosts = configLib.resolveHosts(cfg);
  try {
    const r = await daemon.stop({ hosts, port: cfg.port, force: !!args.flags.force });
    if (r.stopped) console.log('已停止旧进程（PID ' + r.pid + '）');
  } catch (e) {
    console.log('⚠️ 停止旧进程时出问题：' + e.message);
  }
  await new Promise((s) => setTimeout(s, 600));
  await cmdStart({ _: [], flags: {} });
}

// ---------------------------------------------------------------- status
async function cmdStatus(args) {
  const cfg = configLib.load();
  const hosts = configLib.resolveHosts(cfg);
  const st = await daemon.inspect({ hosts, port: cfg.port });

  let probe = null;
  if (st.running && !args.flags['no-probe']) {
    probe = await probeWebdav(st.via || hosts[0], cfg.port, cfg);
  }

  const asy = tryLoadAsy();
  const svc = await serviceLib.status({ system: !!args.flags.system });

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          running: st.running,
          via: st.via,
          pid: st.pid,
          pidSource: st.pidSource,
          port: cfg.port,
          hosts,
          remoteRoot: cfg.remoteRoot,
          probe,
          service: svc,
          asyCli: asy.ok ? { root: asy.root, configDir: asy.configDir } : { error: asy.error },
        },
        null,
        2
      )
    );
    return;
  }

  const line = (k, v) => console.log('  ' + padLabel(k, 13) + ': ' + v);

  console.log('asy-webdav ' + VERSION);
  console.log('');
  console.log('运行状态');
  line('状态', st.running ? '✅ 运行中（' + st.via + ':' + cfg.port + '）' : '⛔ 未运行');
  if (st.pid) line('PID', st.pid + '（来源：' + st.pidSource + '）');
  if (probe) {
    line(
      '端到端',
      probe.ok ? '✅ PROPFIND / → ' + probe.status : '❌ 探测失败：' + (probe.error || probe.status)
    );
  }
  line('服务化', svc.installed ? '✅ 已注册（' + svc.platform + '）' : '未注册');

  console.log('');
  console.log('配置');
  line('配置文件', paths.CONFIG_PATH);
  line('运行目录', fmtHome());
  line('监听', hosts.map((h) => h + ':' + cfg.port).join(', '));
  line('云端根', cfg.remoteRoot);
  line('缓存 TTL', cfg.cacheTtlMs + ' ms');
  line('上传策略', cfg.ondup === 3 ? '覆盖(3)' : cfg.ondup === 2 ? '保留两者(2)' : '拒绝同名(1)');
  line('认证用户', cfg.username + ' / ' + mask(cfg.password));

  console.log('');
  console.log('后端 (asy-cli)');
  if (asy.ok) {
    line('位置', asy.root);
    line('凭据目录', asy.configDir);
    const left = tokenLeft(asy.cfg);
    line('access_token', left === null ? '(无)' : left > 0 ? left + ' 分钟后过期' : '已过期（调用时自动续期）');
  } else {
    line('状态', '❌ ' + String(asy.error).split('\n')[0]);
  }

  if (svc.detail) {
    console.log('');
    console.log('服务详情');
    for (const l of svc.detail.split('\n')) console.log('  ' + l);
  }
}

// ---------------------------------------------------------------- logs
function readLastLines(file, n) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

async function cmdLogs(args) {
  const which = args.flags.access ? paths.ACCESS_LOG : args.flags.err ? paths.ERR_LOG : paths.SERVER_LOG;
  const n = Number(args.flags.n || 30);

  if (!fs.existsSync(which)) {
    console.log('日志文件还不存在：' + which);
    console.log('（服务启动后才会生成）');
    return;
  }

  console.log('==> ' + which + ' <==');
  for (const l of readLastLines(which, n)) console.log(l);

  if (!args.flags.f) return;

  console.log('\n--- 持续跟踪中（Ctrl+C 退出）---');
  let pos = fs.statSync(which).size;
  await new Promise(() => {
    setInterval(() => {
      try {
        const st = fs.statSync(which);
        if (st.size < pos) pos = 0; // 文件被截断（重启时清空）
        if (st.size > pos) {
          const fd = fs.openSync(which, 'r');
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          process.stdout.write(buf);
          pos = st.size;
        }
      } catch {
        /* 文件暂时不可读，下一轮再说 */
      }
    }, 400);
  });
}

// ---------------------------------------------------------------- service
async function cmdService(args) {
  const sub = args._[1];
  const opts = {
    boot: !!args.flags.boot,
    system: !!args.flags.system,
    dryRun: !!args.flags['dry-run'],
    home: typeof args.flags.home === 'string' ? args.flags.home : undefined,
  };

  if (sub === 'status') {
    const s = await serviceLib.status({ system: opts.system, home: opts.home });
    console.log('服务名   : ' + serviceLib.SERVICE_NAME);
    console.log('平台     : ' + s.platform);
    console.log('已注册   : ' + (s.installed ? '✅ 是' : '否'));
    if (s.wrapper) console.log('包装脚本 : ' + s.wrapper + (s.wrapperExists ? '（存在）' : '（缺失）'));
    if (s.detail) console.log(s.detail);
    return;
  }

  if (sub === 'uninstall') {
    const r = await serviceLib.uninstall({ system: opts.system, home: opts.home });
    for (const a of r.actions) console.log('  ' + a);
    for (const f of r.removed) console.log('  已删除: ' + f);
    console.log('✅ 已注销服务');
    return;
  }

  if (sub !== 'install') {
    throw new Error('用法: asy-webdav service [install|uninstall|status] [--boot] [--system]');
  }

  const { asy, cfg, asyConfigDir, asyCliPath } = resolveServiceCreds();

  if (!asy.ok) {
    throw new Error(
      '服务化之前必须先能加载 asy-cli：\n  ' +
        String(asy.error).split('\n')[0] +
        '\n  请先执行 npm install，或设置 ASY_CLI_PATH。'
    );
  }
  if (!asy.cfg || !asy.cfg.refreshToken) {
    console.warn('⚠️ 凭据目录里没有 refresh_token，服务启动后会立刻失败。');
    console.warn('   请先登录：' + asy.root + path.sep + 'asy.js login --cas');
    console.warn('   （若要给服务用独立凭据，先设置 ASY_CONFIG_DIR 再登录）');
    console.warn('');
  }

  const home = opts.home ? path.resolve(opts.home) : paths.HOME;
  if (!opts.home && insideNodeModules(home)) {
    console.warn('⚠️ 运行目录位于 node_modules 内：' + home);
    console.warn('   重装/升级包会丢掉配置和日志。建议改用：');
    console.warn('     asy-webdav service install --home "' + paths.userHomeDir() + '"');
    console.warn('');
  }

  const r = await serviceLib.install({
    boot: opts.boot,
    system: opts.system,
    dryRun: opts.dryRun,
    home,
    asyConfigDir,
    asyCliPath,
  });

  console.log('平台     : ' + r.platform);
  console.log('运行目录 : ' + home);
  console.log('启动方式 : ' + (r.boot ? '开机启动' : '登录后启动') + (r.system ? '（系统级）' : '（用户级）'));
  console.log('asy-cli  : ' + asyCliPath);
  console.log('凭据目录 : ' + asyConfigDir);
  console.log('');

  if (opts.dryRun) {
    console.log('--- 预演，未写入任何文件 ---');
    for (const f of r.files) {
      console.log('\n>>> ' + f.path);
      console.log(f.content);
    }
    return;
  }

  for (const a of r.actions) console.log('  ' + a);
  for (const w of r.warnings || []) console.log('⚠️ ' + w);
  console.log('');
  console.log('✅ 服务已注册');
  if (!r.boot) {
    console.log('   下次登录后会自动启动。现在就启动：asy-webdav start');
  } else {
    console.log('   重启后会自动启动。现在就启动：asy-webdav start');
  }
  if (asyConfigDir && asy.ok && asy.configDir === asyConfigDir) {
    console.log('');
    console.log('⚠️ 服务与 asy 命令行共用同一份凭据（' + asyConfigDir + '）。');
    console.log('   refresh_token 会轮换，两边同时刷新可能互相踢下线。');
    console.log('   建议给服务一份独立凭据：在 config.json 里设置 asyConfigDir 后重新登录。');
  }
}

// ---------------------------------------------------------------- config
function cmdConfig(args) {
  const sub = args._[1];

  if (sub === 'path') {
    console.log('运行目录     : ' + paths.HOME);
    console.log('配置文件     : ' + paths.CONFIG_PATH);
    console.log('PID 文件     : ' + paths.PID_PATH);
    console.log('服务日志     : ' + paths.SERVER_LOG);
    console.log('错误日志     : ' + paths.ERR_LOG);
    console.log('访问日志     : ' + paths.ACCESS_LOG);
    console.log('包目录       : ' + paths.PKG_DIR);
    console.log('平台默认目录 : ' + paths.userHomeDir());
    return;
  }

  const cfg = ensureConfig();

  if (sub === 'show' || !sub) {
    const view = Object.assign({}, cfg);
    view.password = mask(cfg.password);
    console.log('配置文件: ' + paths.CONFIG_PATH);
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  if (sub === 'set') {
    const key = args._[2];
    const value = args._[3];
    if (!key) throw new Error('用法: asy-webdav config set <键> <值>');
    if (!configLib.EDITABLE.includes(key)) {
      throw new Error('未知配置键: ' + key + '\n可用: ' + configLib.EDITABLE.join(', '));
    }
    if (value === undefined) throw new Error('缺少值');

    const d = configLib.defaults()[key];
    if (typeof d === 'number') cfg[key] = Number(value);
    else if (typeof d === 'boolean') cfg[key] = value === 'true' || value === '1';
    else if (Array.isArray(d)) cfg[key] = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else cfg[key] = value;

    configLib.save(cfg);
    console.log('✅ ' + key + ' = ' + (key === 'password' ? mask(value) : JSON.stringify(cfg[key])));
    if (key === 'port' || key === 'hosts' || key === 'host') {
      console.log('   监听相关配置改了，需要重启才生效：asy-webdav restart');
    }
    return;
  }

  throw new Error('用法: asy-webdav config [show|set <键> <值>|path]');
}

// ---------------------------------------------------------------- doctor
async function cmdDoctor() {
  const results = [];
  const add = (level, title, detail) => results.push({ level, title, detail });

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  add(
    major >= 18 ? 'ok' : 'fail',
    'Node.js 版本',
    process.version + (major >= 18 ? '' : '（需要 18 或更高）')
  );

  // 2. 运行目录可写
  try {
    paths.ensureHome();
    const probeFile = path.join(paths.HOME, '.write-test');
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    add('ok', '运行目录可写', paths.HOME);
  } catch (e) {
    add('fail', '运行目录不可写', paths.HOME + ' —— ' + e.message);
  }

  // 3. 配置文件
  let cfg = null;
  try {
    cfg = configLib.load();
    if (fs.existsSync(paths.CONFIG_PATH)) {
      add('ok', '配置文件', paths.CONFIG_PATH);
    } else {
      add('warn', '配置文件不存在', paths.CONFIG_PATH + '（首次启动会自动生成）');
    }
  } catch (e) {
    add('fail', '配置文件无法解析', e.message);
  }

  // 4. 监听地址是否属于本机 —— 换机器部署最容易踩的坑
  if (cfg) {
    // 空密码 = 任何人都能用空密码读写云盘（实测 PROPFIND 返回 207）
    if (!cfg.password) {
      add(
        'fail',
        'WebDAV 密码为空',
        '任何人都能用「用户名 ' + cfg.username + ' + 空密码」读写你的云盘。\n' +
          '    立刻修复：asy-webdav config set password <一个强密码>'
      );
    }

    const hosts = configLib.resolveHosts(cfg);
    const locals = localAddresses();
    const bad = hosts.filter((h) => !locals.has(h));
    if (bad.length) {
      add(
        'fail',
        '监听地址不属于本机',
        bad.join(', ') + '\n    服务会因 EADDRNOTAVAIL 启动失败。' +
          '\n    换机器后请更新 config.json 的 hosts（本机地址：' +
          [...locals].filter((a) => !a.startsWith('127.') && a !== '::1' && a !== 'localhost').join(', ') +
          '）'
      );
    } else {
      add('ok', '监听地址', hosts.map((h) => h + ':' + cfg.port).join(', '));
    }

    // 5. 端口占用
    const st = await daemon.inspect({ hosts, port: cfg.port });
    if (st.running) {
      add('ok', '服务运行中', st.via + ':' + cfg.port + (st.pid ? '（PID ' + st.pid + '）' : ''));
      const probe = await probeWebdav(st.via || hosts[0], cfg.port, cfg);
      add(
        probe.ok ? 'ok' : 'fail',
        '端到端探测',
        probe.ok ? 'PROPFIND / → ' + probe.status : '失败：' + (probe.error || probe.status)
      );
    } else {
      add('warn', '服务未运行', '启动：asy-webdav start');
    }
  }

  // 6. asy-cli 解析
  const asy = tryLoadAsy();
  if (asy.ok) {
    add('ok', 'asy-cli', asy.root);
  } else {
    add('fail', 'asy-cli 加载失败', String(asy.error));
  }

  // 7. 凭据
  if (asy.ok) {
    const credFile = path.join(asy.configDir, 'config.json');
    if (!fs.existsSync(credFile)) {
      add('fail', '凭据文件不存在', credFile + '\n    请先登录：node "' + path.join(asy.root, 'asy.js') + '" login --cas');
    } else if (!asy.cfg.refreshToken) {
      add('fail', '凭据里没有 refresh_token', credFile + '\n    请重新登录。');
    } else {
      const left = tokenLeft(asy.cfg);
      add(
        'ok',
        '凭据',
        credFile + (left === null ? '' : left > 0 ? '（access_token 还有 ' + left + ' 分钟）' : '（access_token 已过期，会自动续期）')
      );
    }
  }

  // 8. 服务化状态
  const svc = await serviceLib.status({});
  add(svc.installed ? 'ok' : 'warn', '服务化（自启）', svc.installed ? '已注册' : '未注册（asy-webdav service install）');

  // ---- 输出
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  console.log('asy-webdav 环境自检');
  console.log('');
  for (const r of results) {
    console.log(icon[r.level] + ' ' + r.title);
    if (r.detail) for (const l of String(r.detail).split('\n')) console.log('     ' + l);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 项失败' + (warns ? '，' + warns + ' 项警告' : '') : warns ? '⚠️  ' + warns + ' 项警告，其余正常' : '✅ 全部正常');
  if (fails) process.exitCode = 1;
}

// ---------------------------------------------------------------- login
/**
 * 委托给 asy-cli 的登录流程。
 * 存在的意义：全局安装 asy-webdav 时，npm **不会**把 asy-cli 的 `asy` 命令
 * 放到 PATH 上（它只躺在包的内部 .bin 里）。这里直接用装载器解析到的那个
 * asy-cli 实例，既省掉一次全局安装，也保证凭据写进服务将要读取的目录。
 */
async function cmdLogin(args) {
  const asy = tryLoadAsy();
  if (!asy.ok) {
    throw new Error(
      '找不到 asy-cli，无法登录：\n  ' +
        String(asy.error).split('\n')[0] +
        '\n  请先执行 npm install，或设置 ASY_CLI_PATH。'
    );
  }

  const cfg = configLib.load();
  const env = Object.assign({}, process.env);
  if (cfg.asyConfigDir) env.ASY_CONFIG_DIR = path.resolve(cfg.asyConfigDir);

  const asyJs = path.join(asy.root, 'asy.js');
  const passthrough = process.argv.slice(3); // `login` 之后的参数原样转发

  console.log('调用: ' + asyJs + ' login ' + passthrough.join(' '));
  console.log('凭据目录: ' + (env.ASY_CONFIG_DIR || asy.configDir));
  console.log('');

  const { spawn } = require('child_process');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [asyJs, 'login'].concat(passthrough), {
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('exit', (c) => resolve(c === null ? 1 : c));
  });
  if (code !== 0) {
    const e = new Error('登录未成功（退出码 ' + code + '）');
    e.code = 'ELOGINFAILED';
    throw e;
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (!cmd || cmd === 'help') {
    console.log(HELP);
    return;
  }
  // login 的 --help 要转发给 asy-cli，否则用户看不到它自己的参数说明
  if (args.flags.help && cmd !== 'login') {
    console.log(HELP);
    return;
  }

  const table = {
    start: cmdStart,
    stop: cmdStop,
    restart: cmdRestart,
    status: cmdStatus,
    logs: cmdLogs,
    service: cmdService,
    config: async (a) => cmdConfig(a),
    login: cmdLogin,
    doctor: cmdDoctor,
  };

  const fn = table[cmd];
  if (!fn) {
    console.error('未知命令: ' + cmd + '\n');
    console.log(HELP);
    process.exitCode = 2;
    return;
  }
  await fn(args);
}

// 只有直接执行时才跑 main()，被 require 时（测试）只导出纯函数
if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ ' + (e && e.message ? e.message : e));
    if (process.env.ASY_TRACE && e && e.stack) console.error(e.stack);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, dispWidth, padLabel, probeWebdav, localAddresses, mask };
