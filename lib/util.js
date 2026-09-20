// ============================================================================
// asy-webdav - 通用小工具：TTL 缓存 + 并发闸门
// ============================================================================

'use strict';

/**
 * 带过期时间的键值缓存。
 * 用 has() 区分「没缓存」和「缓存了 null（已确认不存在）」。
 */
class TtlCache {
  constructor(defaultTtlMs = 15000, maxEntries = 5000) {
    this.map = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  has(key) {
    const rec = this.map.get(key);
    if (!rec) return false;
    if (rec.expireAt <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    if (!this.has(key)) return undefined;
    return this.map.get(key).value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.maxEntries) this.evictExpired();
    this.map.set(key, {
      value,
      expireAt: Date.now() + (ttlMs === undefined ? this.defaultTtlMs : ttlMs),
    });
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  evictExpired() {
    const now = Date.now();
    for (const [k, rec] of this.map) {
      if (rec.expireAt <= now) this.map.delete(k);
    }
    // 仍然超限就丢掉最早插入的一批（Map 保持插入顺序）
    if (this.map.size >= this.maxEntries) {
      const drop = Math.ceil(this.maxEntries / 4);
      let i = 0;
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  get size() {
    return this.map.size;
  }
}

/**
 * 并发闸门：限制同时在飞的请求数，避免把学校服务器打爆。
 */
class Semaphore {
  constructor(max = 4) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const exec = () => {
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.active < this.max) exec();
      else this.queue.push(exec);
    });
  }
}

/** 规范化 WebDAV 路径：'' / '/' -> '/'，'/a//b/' -> '/a/b' */
function normalizePath(p) {
  let s = String(p === undefined || p === null ? '/' : p).replace(/\\/g, '/');
  s = s.split('/').filter(Boolean).join('/');
  return '/' + s;
}

function parentPath(p) {
  const norm = normalizePath(p);
  if (norm === '/') return '/';
  const parts = norm.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

function baseName(p) {
  const norm = normalizePath(p);
  if (norm === '/') return '';
  return norm.split('/').filter(Boolean).pop();
}

function joinPath(parent, child) {
  const a = normalizePath(parent);
  const b = String(child).split('/').filter(Boolean).join('/');
  if (a === '/') return '/' + b;
  return a + '/' + b;
}

/** 把未知错误压成一行可读文本 */
function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  TtlCache,
  Semaphore,
  normalizePath,
  parentPath,
  baseName,
  joinPath,
  errText,
  sleep,
};
