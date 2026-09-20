// ============================================================================
// asy-webdav - 进程生命周期管理
// ----------------------------------------------------------------------------
// 提供与平台无关的 start / stop / status：
//   * 自己托管时用 PID 文件（ASY_WEBDAV_HOME/server.pid）
//   * 但「是否在运行」以**端口能否连通**为准 —— 因为服务由 systemd /
//     任务计划程序拉起时根本没有 PID 文件，那种情况下 PID 文件是靠不住的。
//   * 所以进程归属采用「先读 PID 文件，读不到就按端口反查」的策略。
// ============================================================================

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');

const paths = require('./paths');

const SERVER_JS = path.join(paths.PKG_DIR, 'server.js');

// ---------------------------------------------------------------- PID 文件
function readPid() {
  try {
    const t = fs.readFileSync(paths.PID_PATH, 'utf8').trim();
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  paths.ensureHome();
  fs.writeFileSync(paths.PID_PATH, String(pid), 'utf8');
}

function removePid() {
  try {
    fs.unlinkSync(paths.PID_PATH);
  } catch {
    /* 本来就没有 */
  }
}

/** 进程是否存活（signal 0 只做存在性检查，不真的发信号） */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不属于当前用户
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- 端口
/** TCP 探测某地址:端口是否可连 */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

/**
 * 按端口反查占用进程的 PID。用于「服务不是我启动的」场景。
 * 查不到返回 null（不影响主流程，只是状态里少一行信息）。
 */
async function findPidByPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = await run('netstat', ['-ano', '-p', 'tcp']);
      const re = new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'm');
      const m = out.match(re);
      return m ? Number(m[1]) : null;
    }

    // Linux: ss 更可靠且无需 root 就能看到自己的进程
    const ss = await run('ss', ['-lptnH', 'sport = :' + port]);
    const m = ss.match(/pid=(\d+)/);
    if (m) return Number(m[1]);

    // 退路：lsof（macOS 默认没有 ss）
    const lsof = await run('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN']);
    const first = lsof.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 运行判定
/**
 * 判断服务是否在运行：只要配置里任一监听地址能连通就算运行。
 * 这样无论服务是谁拉起来的（自己 / systemd / 计划任务）都判断得出来。
 */
async function checkRunning(hosts, port) {
  const list = (hosts && hosts.length ? hosts : ['127.0.0.1']).filter(Boolean);
  for (const h of list) {
    // eslint-disable-next-line no-await-in-loop
    if (await probePort(h, port)) return { running: true, via: h };
  }
  return { running: false, via: null };
}

/** 汇总当前运行状态 */
async function inspect({ hosts, port }) {
  const { running, via } = await checkRunning(hosts, port);
  let pid = readPid();
  let pidSource = pid ? 'pid 文件' : null;

  if (!isAlive(pid)) {
    if (pid) pidSource = 'pid 文件（已失效）';
    pid = null;
  }
  if (!pid && running) {
    const found = await findPidByPort(port);
    if (found) {
      pid = found;
      pidSource = '端口反查';
    }
  }
  return { running, via, pid, pidSource, pidAlive: isAlive(pid) };
}

// ---------------------------------------------------------------- start
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读取文件末尾若干行（日志报错用） */
function readTail(file, lines = 20) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return txt.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 后台启动服务。
 * @returns {Promise<{pid:number}>}
 */
async function start({ hosts, port, env = {}, readyTimeoutMs = 25000 }) {
  const cur = await inspect({ hosts, port });
  if (cur.running) {
    const e = new Error(
      `服务已在运行（${cur.via}:${port}${cur.pid ? '，PID ' + cur.pid : ''}）。` +
        `如需重启请用 asy-webdav restart。`
    );
    e.code = 'EALREADYRUNNING';
    throw e;
  }

  paths.ensureHome();
  // 启动前清掉上一次的日志，否则报错时 tail 到的可能是旧内容
  fs.writeFileSync(paths.SERVER_LOG, '');
  fs.writeFileSync(paths.ERR_LOG, '');

  const out = fs.openSync(paths.SERVER_LOG, 'a');
  const err = fs.openSync(paths.ERR_LOG, 'a');

  const child = spawn(process.execPath, [SERVER_JS], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    cwd: paths.PKG_DIR,
    env: Object.assign({}, process.env, env),
  });
  child.unref();
  writePid(child.pid);

  // 等端口就绪；同时留意子进程是否已经挂掉（配置错、端口占用等）
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkRunning(hosts, port);
    if (ok.running) return { pid: child.pid, via: ok.via };

    if (!isAlive(child.pid)) {
      removePid();
      const tail = readTail(paths.ERR_LOG, 15) || readTail(paths.SERVER_LOG, 15);
      const e = new Error('服务启动后立即退出。日志末尾：\n' + (tail || '(空)'));
      e.code = 'ESTARTFAILED';
      throw e;
    }
  }

  const tail = readTail(paths.ERR_LOG, 15) || readTail(paths.SERVER_LOG, 15);
  const e = new Error(
    `等待 ${readyTimeoutMs / 1000} 秒后端口仍未就绪（${hosts.join(', ')}:${port}）。\n` +
      '日志末尾：\n' +
      (tail || '(空)')
  );
  e.code = 'ETIMEOUT';
  throw e;
}

// ---------------------------------------------------------------- stop
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  return !isAlive(pid);
}

/**
 * 停止服务。
 * 注意 Windows：Node 的 process.kill 对同平台进程走 TerminateProcess，
 * 目标进程收不到 SIGTERM 回调，所以收尾（删 pid 文件）由这里负责。
 */
async function stop({ hosts, port, force = false }) {
  const cur = await inspect({ hosts, port });

  if (!cur.pid || !cur.pidAlive) {
    if (!cur.running) {
      removePid();
      return { stopped: false, reason: 'not-running' };
    }
    // 端口被占但找不到 PID：可能是权限不足
    if (!force) {
      const e = new Error(
        `端口 ${port} 被占用，但无法确定占用进程的 PID（可能需要更高权限）。\n` +
          '确认要强制停止请加 --force。'
      );
      e.code = 'ENOPID';
      throw e;
    }
  }

  const pid = cur.pid;
  if (!pid) {
    removePid();
    return { stopped: false, reason: 'not-running' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }

  let gone = await waitForExit(pid, 8000);

  if (!gone && process.platform === 'win32') {
    // Windows 上 TerminateProcess 应该已经生效；还没死就上 taskkill 连子进程一起收
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    gone = await waitForExit(pid, 4000);
  } else if (!gone) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
    gone = await waitForExit(pid, 4000);
  }

  removePid();
  if (!gone) {
    const e = new Error(`进程 ${pid} 未能停止，请手动处理。`);
    e.code = 'EKILLFAILED';
    throw e;
  }
  return { stopped: true, pid };
}

module.exports = {
  SERVER_JS,
  readPid,
  writePid,
  removePid,
  isAlive,
  probePort,
  findPidByPort,
  checkRunning,
  inspect,
  start,
  stop,
  readTail,
};
