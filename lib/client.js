// ============================================================================
// asy-webdav - AnyShare 云盘访问层
// ----------------------------------------------------------------------------
// 把 asy-cli 的 AnyShareApi 包装成「面向 WebDAV 的条目模型」：
//   - 路径 <-> docid 解析（带目录列举缓存，避免逐层打 API）
//   - 目录列举缓存 + 条目缓存 + 写操作后定向失效
//   - 所有 API 调用走并发闸门，避免高频轮询学校服务器
//
// 条目模型（entry）：
//   { docid, name, type: 'dir'|'file', size, mtime(ms), ctime(ms), rev }
// ============================================================================

'use strict';

const asy = require('./asy-cli');
const { TtlCache, Semaphore, normalizePath, parentPath, baseName, joinPath, errText, sleep } = require('./util');

/** 云盘时间戳（ISO，秒级）-> 毫秒 */
function parseTime(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 把 sub_objects 返回的原始条目转成统一 entry。
 * 判据来自实测：目录的 size === -1。
 */
function toEntry(raw) {
  const isDir = raw.size === -1 || raw.type === 'dir' || raw.type === 'directory';
  return {
    docid: raw.id || raw.docid || '',
    name: raw.name || '',
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : Number(raw.size) || 0,
    mtime: parseTime(raw.modified_at || raw.mtime),
    ctime: parseTime(raw.created_at || raw.ctime),
    rev: raw.rev || '',
  };
}

class AnyShareClient {
  /**
   * @param {object} opts
   * @param {object} opts.cfg          asy-cli 配置（config.load() 的结果）
   * @param {string} [opts.basePath]   WebDAV 根对应的云端路径，如 '/WebDAV/SyncDisk'
   * @param {number} [opts.ttlMs]      缓存有效期
   * @param {number} [opts.concurrency] API 并发上限
   * @param {number} [opts.timeoutMs]   单次 API 请求超时
   * @param {number} [opts.readRetries] 只读 API 失败后的重试次数
   * @param {boolean} [opts.debug]     打印每次 API 调用
   * @param {function} [opts.log]      日志函数 (level, message)
   * @param {object} [opts.api]        注入自定义 API 实现（测试用；默认走 asy-cli）
   */
  constructor(opts = {}) {
    this.cfg = opts.cfg || asy.config.load();
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
    this.readRetries = Number(opts.readRetries) >= 0 ? Math.floor(Number(opts.readRetries)) : 1;
    this.api = opts.api || new asy.AnyShareApi(this.cfg, {
      debug: !!opts.debug,
      timeoutMs: this.timeoutMs,
    });
    this.basePath = normalizePath(opts.basePath || '/');
    this.debug = !!opts.debug;
    this.log = opts.log || ((level, message) => console.error(`[asy] [${level}] ${message}`));

    const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 15000;
    this.listingCache = new TtlCache(ttl); // path -> Map<name, entry>
    this.entryCache = new TtlCache(ttl);   // path -> entry | null
    this.rootTtl = Math.max(ttl, 300000);  // 根 docid 变化极少，缓存久一点

    this.sem = new Semaphore(Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 4);
    this._root = null;
    this.inflightListings = new Map();
    this.stats = { apiCalls: 0, retries: 0, coalesced: 0, cacheHits: 0, cacheMisses: 0 };

    // 所有 API 调用过闸门 + 计数
    const rawCall = this.api.call.bind(this.api);
    this.api.call = (method, apiPath, o = {}) => {
      return this.sem.run(async () => {
        const retryable = this._isRetryableRead(method, apiPath);
        const attempts = retryable ? this.readRetries + 1 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const started = Date.now();
          this.stats.apiCalls++;
          try {
            const result = await rawCall(method, apiPath, Object.assign({ timeoutMs: this.timeoutMs }, o));
            if (this.debug) this.log('debug', `${method} ${apiPath} ${Date.now() - started} ms`);
            return result;
          } catch (e) {
            const duration = Date.now() - started;
            const transient = e && (e.status === 503 || e.status === 504);
            if (transient && attempt < attempts) {
              this.stats.retries++;
              this.log('warn', `${method} ${apiPath} ${duration} ms 后失败，正在重试 (${attempt}/${attempts - 1})`);
              await sleep(200 * attempt);
              continue;
            }
            this.log('error', `${method} ${apiPath} ${duration} ms 后失败: ${errText(e)}`);
            if (/invalid_grant|refresh[_ ]?token|refresh token/i.test(errText(e))) {
              const wrapped = new Error(
                `${errText(e)}  ← refresh_token 可能已被另一个进程（比如 asy 命令行）轮换作废。` +
                  `请给本服务设置独立的 asyConfigDir 并重新登录，或先停掉其他 asy 进程。`
              );
              wrapped.cause = e;
              wrapped.status = e.status;
              wrapped.data = e.data;
              throw wrapped;
            }
            throw e;
          }
        }
      });
    };
  }

  _isRetryableRead(method, apiPath) {
    if (String(method).toUpperCase() === 'GET') return true;
    return [
      '/efast/v1/file/convertpath',
      '/efast/v1/file/getinfobypath',
      '/efast/v1/file/osdownload',
    ].includes(apiPath);
  }

  // ---------------------------------------------------------------- 根目录
  /** WebDAV 的 '/' 对应的云端目录条目 */
  async rootEntry() {
    if (this._root) return this._root;
    const r = await this.api.resolvePath(this.basePath === '/' ? '' : this.basePath);
    if (!r || !r.docid) throw new Error(`无法解析云端根目录: ${this.basePath}`);
    this._root = {
      docid: r.docid,
      name: '',
      type: 'dir',
      size: 0,
      mtime: 0,
      ctime: 0,
      rev: '',
    };
    return this._root;
  }

  // ------------------------------------------------------------ 路径 -> 条目
  /**
   * 解析 WebDAV 路径为条目；不存在返回 null。
   * 逐段下推，但每一层的「目录列举」都进缓存，因此解析 N 个同目录条目
   * 只会产生 1 次 sub_objects 请求。
   */
  async resolveEntry(p) {
    const norm = normalizePath(p);
    if (this.entryCache.has(norm)) {
      this.stats.cacheHits++;
      return this.entryCache.get(norm);
    }
    this.stats.cacheMisses++;

    if (norm === '/') {
      const root = await this.rootEntry();
      this.entryCache.set(norm, root, this.rootTtl);
      return root;
    }

    const parent = parentPath(norm);
    const listing = await this.listDir(parent);
    const entry = listing ? listing.get(baseName(norm)) || null : null;
    this.entryCache.set(norm, entry);
    return entry;
  }

  /**
   * 列举目录（带缓存）。返回 Map<name, entry>；目录不存在返回 null。
   */
  async listDir(p) {
    const norm = normalizePath(p);
    if (this.listingCache.has(norm)) {
      this.stats.cacheHits++;
      return this.listingCache.get(norm);
    }
    this.stats.cacheMisses++;

    if (this.inflightListings.has(norm)) {
      this.stats.coalesced++;
      return this.inflightListings.get(norm);
    }

    const pending = this._loadDir(norm);
    this.inflightListings.set(norm, pending);
    try {
      return await pending;
    } finally {
      this.inflightListings.delete(norm);
    }
  }

  async _loadDir(norm) {
    const self = await this.resolveEntry(norm);
    if (!self || self.type !== 'dir') {
      this.listingCache.set(norm, null);
      return null;
    }

    const { dirs, files } = await this.api.listFolder(self.docid);
    const map = new Map();
    for (const raw of dirs || []) {
      const e = toEntry(raw);
      if (e.name) map.set(e.name, e);
    }
    for (const raw of files || []) {
      const e = toEntry(raw);
      if (e.name) map.set(e.name, e);
    }

    this.listingCache.set(norm, map);
    // 顺手把子条目也灌进条目缓存，省掉后续逐条解析
    for (const [name, e] of map) {
      this.entryCache.set(joinPath(norm, name), e);
    }
    return map;
  }

  // ------------------------------------------------------------ 缓存失效
  /** 写操作后定向失效：自身条目 + 父目录列举 + （目录则含）自身列举 */
  invalidate(p) {
    const norm = normalizePath(p);
    this.entryCache.delete(norm);
    this.listingCache.delete(parentPath(norm));
    if (norm !== '/') this.listingCache.delete(norm);
  }

  /** 直接把已知结果写回缓存（用于 mkdir 等已知结果的场景） */
  prime(norm, entry) {
    this.entryCache.set(normalizePath(norm), entry);
  }

  invalidateAll() {
    this.listingCache.clear();
    this.entryCache.clear();
  }

  // ------------------------------------------------------------ 目录 / 文件操作
  async mkdir(parentDocid, name) {
    const docid = await this.api.mkdir(parentDocid, name);
    return docid;
  }

  async remove(entry) {
    return this.api.remove([{ docid: entry.docid, type: entry.type === 'dir' ? 'dir' : 'file' }]);
  }

  /** 递归删除（先试直接删；目录非空被拒时再自底向上删） */
  async removeRecursive(entry) {
    if (entry.type !== 'dir') return this.remove(entry);
    try {
      return await this.remove(entry);
    } catch (e) {
      const { dirs, files } = await this.api.listFolder(entry.docid);
      for (const raw of dirs || []) await this.removeRecursive(toEntry(raw));
      for (const raw of files || []) await this.remove(toEntry(raw));
      return this.remove(entry);
    }
  }

  async rename(docid, newName, ondup = 1) {
    return this.api.rename(docid, newName, ondup);
  }

  /**
   * 把条目改名成一个**确定空着**的名字。
   *
   * 为什么不能直接传 ondup：实测 file/rename 的取值和上传不一样 ——
   *   ondup=1 → 目标同名时报 403「存在同类型的同名文件名」
   *   ondup=3 → 直接报 403「当前操作不支持覆盖」（根本不接受覆盖）
   *   ondup=2 → 调用成功，但实测目标内容没变、源文件却没了（有丢数据风险，绝不能用）
   * 所以只能 ondup=1，并且调用方必须保证目标名是空的。
   *
   * 又因为云盘删除是最终一致的，刚删掉同名条目后立刻改名可能仍被判为同名，
   * 这里做几次短暂重试；仍然失败就抛错 —— 宁可报 409，也不冒覆盖/丢数据的风险。
   */
  async renameInto(docid, newName, attempts = 3) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.api.rename(docid, newName, 1);
        return;
      } catch (e) {
        lastErr = e;
        if (!/同名|已存在|already exists/i.test(errText(e))) throw e;
        await sleep(400 * (i + 1));
      }
    }
    throw lastErr;
  }

  async move(docid, destParentDocid, ondup = 1) {
    return this.api.move(docid, destParentDocid, ondup);
  }

  async copy(docid, destParentDocid, ondup = 1) {
    return this.api.copy(docid, destParentDocid, ondup);
  }

  // ------------------------------------------------------------ 上传
  /**
   * 开始上传。asy-cli 的 api.osbeginupload 需要本地文件路径（内部 statSync），
   * 而 WebDAV 的 PUT 是流式 body，所以这里直接调 API，自己带 length。
   */
  async beginUpload(folderDocid, fileName, length, ondup = 1, clientMtimeMs) {
    const payload = {
      client_mtime: Math.floor(clientMtimeMs || Date.now()),
      docid: folderDocid,
      length: Math.floor(length),
      name: fileName,
      ondup: Number(ondup),
      reqmethod: 'POST',
    };
    const data = await this.api.call('POST', '/efast/v1/file/osbeginupload', { json: payload });
    const req = data && data.authrequest;
    if (!Array.isArray(req) || req.length < 2) {
      throw new Error('osbeginupload 返回的 authrequest 格式异常: ' + JSON.stringify(data).slice(0, 300));
    }
    const method = String(req[0] || 'POST').toUpperCase();
    const url = req[1];
    const parsed = asy.parseAuthEntries(req.slice(2), method);
    return {
      method,
      url,
      headers: parsed.headers,
      form: parsed.form,
      docid: data.docid,
      rev: data.rev,
      csflevel: data.csflevel || 0,
    };
  }

  async endUpload(docid, rev, csflevel = 0) {
    return this.api.osendupload(docid, rev, csflevel);
  }

  // ------------------------------------------------------------ 下载
  /**
   * 取得下载直链 + 必须原样携带的签名头。
   */
  async openDownload(entry) {
    const data = await this.api.osdownload(entry.docid, entry.name);
    const req = data && data.raw && data.raw.authrequest;
    const method = String((data && data.method) || 'GET').toUpperCase();
    const url = data && data.url;
    if (!url) throw new Error('osdownload 未返回下载地址: ' + JSON.stringify(data && data.raw).slice(0, 300));
    const parsed = asy.parseAuthEntries(data.entries, method);
    return { method, url, headers: parsed.headers, raw: req };
  }
}

module.exports = { AnyShareClient, toEntry, parseTime, errText };
