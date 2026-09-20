// ============================================================================
// asy-webdav - access.log 分析器
// ----------------------------------------------------------------------------
// 用来回答「缓存策略该怎么定」这类问题：从真实访问日志里量出重复模式、
// 时间间隔分布，并模拟不同 TTL 下能省下多少云盘请求。
//
//   node scripts/analyze-log.js [--log access.log]
//
// 模拟规则（和准备实现的策略一致）：
//   * 正文缓存以 URL 为键；命中条件是「同 URL 在 TTL 内被再次请求」
//   * 对某 URL 的 PUT/DELETE 会立刻失效该 URL 的缓存
//   * PROPFIND 视为一次同步的开始，用来切分同步轮次
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LOG = path.resolve(arg('log', path.join(__dirname, '..', 'access.log')));

function parseLine(line) {
  const parts = line.split(' | ');
  if (parts.length < 4) return null;
  const t = Date.parse(parts[0]);
  if (!Number.isFinite(t)) return null;
  return { t, method: parts[1], url: parts[2], status: Number(parts[3]) };
}

function fmtDur(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'min';
}

function main() {
  if (!fs.existsSync(LOG)) {
    console.error('找不到日志: ' + LOG);
    process.exit(1);
  }
  const reqs = fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .map(parseLine)
    .filter(Boolean);

  if (!reqs.length) {
    console.error('日志为空');
    process.exit(1);
  }

  const t0 = reqs[0].t;
  const t1 = reqs[reqs.length - 1].t;
  console.log('='.repeat(74));
  console.log('访问日志分析: ' + LOG);
  console.log('  请求数   : ' + reqs.length);
  console.log('  时间跨度 : ' + fmtDur(t1 - t0) + '  (' + new Date(t0).toISOString() + ' ~ ' + new Date(t1).toISOString() + ')');
  console.log('='.repeat(74));

  // ---------------- 按 URL 统计重复 ----------------
  const byUrl = new Map();
  for (const r of reqs) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r);
  }
  const distinct = byUrl.size;
  const repeats = [...byUrl.entries()].filter(([, v]) => v.length > 1);

  console.log('');
  console.log('--- URL 重复情况 ---');
  console.log(`  不同 URL      : ${distinct}`);
  console.log(`  总请求        : ${reqs.length}`);
  console.log(`  被重复请求的 URL: ${repeats.length} 个，共 ${repeats.reduce((s, [, v]) => s + v.length, 0)} 次请求`);

  // 间隔分布
  const gaps = [];
  for (const [, list] of byUrl) {
    for (let i = 1; i < list.length; i++) gaps.push(list[i].t - list[i - 1].t);
  }
  gaps.sort((a, b) => a - b);
  if (gaps.length) {
    console.log('');
    console.log('--- 同一 URL 相邻两次请求的间隔分布 ---');
    const buckets = [
      ['< 5s', 0, 5000],
      ['5~15s', 5000, 15000],
      ['15~60s', 15000, 60000],
      ['1~5min', 60000, 300000],
      ['5~30min', 300000, 1800000],
      ['> 30min', 1800000, Infinity],
    ];
    for (const [label, lo, hi] of buckets) {
      const n = gaps.filter((g) => g >= lo && g < hi).length;
      const bar = '#'.repeat(Math.round((n / gaps.length) * 40));
      console.log(`  ${label.padEnd(9)} ${String(n).padStart(4)}  ${bar}`);
    }
    console.log(`  中位数 ${fmtDur(gaps[Math.floor(gaps.length / 2)])} / 最小 ${fmtDur(gaps[0])} / 最大 ${fmtDur(gaps[gaps.length - 1])}`);
  }

  // ---------------- TTL 模拟 ----------------
  console.log('');
  console.log('--- 不同 TTL 下能省掉的云盘请求 ---');
  console.log('  (GET 命中缓存 = 省掉 1 次 osdownload API + 1 次对象存储拉取)');
  console.log('');
  console.log('  TTL        GET总数  命中   省下    命中率');
  const getReqs = reqs.filter((r) => r.method === 'GET');
  for (const ttl of [5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000]) {
    const cache = new Map(); // url -> 上次取回的时间
    let hits = 0;
    for (const r of reqs) {
      if (r.method === 'GET') {
        const last = cache.get(r.url);
        if (last !== undefined && r.t - last <= ttl) {
          hits++;
          // 命中不刷新时间（模拟「缓存条目 TTL 从写入算起」）
        } else {
          cache.set(r.url, r.t);
        }
      } else if (r.method === 'PUT' || r.method === 'DELETE') {
        cache.delete(r.url);
      }
    }
    const label = ttl < 60000 ? ttl / 1000 + 's' : ttl / 60000 + 'min';
    const pct = ((hits / getReqs.length) * 100).toFixed(1) + '%';
    console.log(
      `  ${label.padEnd(10)} ${String(getReqs.length).padStart(6)}  ${String(hits).padStart(6)}  ${String(hits).padStart(6)}  ${pct.padStart(6)}`
    );
  }

  // ---------------- 同步轮次切分 ----------------
  console.log('');
  console.log('--- 同步轮次（以 PROPFIND 为界）---');
  const runs = [];
  let cur = null;
  for (const r of reqs) {
    if (r.method === 'PROPFIND') {
      if (cur) runs.push(cur);
      cur = { start: r.t, end: r.t, n: 1, gets: 0, puts: 0, dels: 0 };
      continue;
    }
    if (!cur) cur = { start: r.t, end: r.t, n: 0, gets: 0, puts: 0, dels: 0 };
    cur.n++;
    cur.end = r.t;
    if (r.method === 'GET') cur.gets++;
    if (r.method === 'PUT') cur.puts++;
    if (r.method === 'DELETE') cur.dels++;
  }
  if (cur) runs.push(cur);
  runs.forEach((run, i) => {
    console.log(
      `  第 ${String(i + 1).padStart(2)} 轮  持续 ${fmtDur(run.end - run.start).padStart(7)}  ` +
        `GET ${String(run.gets).padStart(4)}  PUT ${String(run.puts).padStart(3)}  DEL ${run.dels}`
    );
  });

  // ---------------- 文件类型 ----------------
  console.log('');
  console.log('--- 请求的文件类型 ---');
  const ext = new Map();
  for (const r of reqs) {
    if (r.method !== 'GET') continue;
    const name = decodeURIComponent(r.url.split('/').pop() || '');
    const e = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '(无扩展名)';
    ext.set(e, (ext.get(e) || 0) + 1);
  }
  for (const [e, n] of [...ext.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${e.padEnd(14)} ${n}`);
  }

  // ---------------- 缓存体积估算 ----------------
  console.log('');
  console.log('--- 如果缓存正文，内存占用估算 ---');
  console.log('  .prop 实测 110 字节/个。按当前目录 295 个 .prop 算：');
  console.log('    全量 .prop 正文 ≈ ' + ((295 * 110) / 1024).toFixed(1) + ' KB  (可忽略)');
  console.log('  但 .zip 单个可达 19 MB，必须设大小上限，否则内存会炸。');
}

main();
