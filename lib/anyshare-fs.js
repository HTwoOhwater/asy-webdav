// ============================================================================
// asy-webdav - AnyShare WebDAV 文件系统
// ----------------------------------------------------------------------------
// 继承 webdav-server 的 FileSystem 抽象类，把所有钩子接到 AnyShare 云盘 API。
//
// WebDAV 方法 -> 本文件钩子 -> 云盘 API
//   PROPFIND  _readDir/_type/_size/_etag/_lastModifiedDate   -> sub_objects
//   GET/HEAD  _openReadStream                                -> osdownload(签名直链)
//   PUT       _create(空操作) + _openWriteStream              -> osbeginupload -> 直传 -> osendupload
//   MKCOL     _create(directory)                             -> dir/create
//   DELETE    _delete                                        -> file|dir/delete
//   MOVE      _move                                          -> file/move (+ file/rename)
//   COPY      _copy                                          -> file/copy (+ file/rename)
//   LOCK      _lockManager                                   -> 内存锁
//   PROPPATCH _propertyManager                               -> 内存属性
//
// 设计要点（都是从 webdav-server 源码里读出来的契约，不能想当然）：
//   * FileSystem.create() 在 PUT 新文件时也会先调 _create(ResourceType.File)，
//     随后才调 _openWriteStream()。所以 _create(file) 必须是空操作，
//     真正落盘交给 _openWriteStream，否则云盘会先多出一个 0 字节文件。
//   * Put 命令等的是 wStream 的 'finish' 事件，所以上传流必须在 _final 里
//     完成 osendupload 之后才回调 —— 否则客户端会在文件真正写完前收到 200。
//   * Get 命令用 _size() 的结果设置 Content-Length，所以 _size 必须准确，
//     否则下载会截断或挂住。Range 请求由 webdav-server 自己包装流处理。
//   * 目录的 size 是 -1，绝不能透传（会导致 Content-Length: -1）。
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Writable } = require('stream');

// 注意：webdav-server 的默认导出是 v1，v2 挂在 .v2 上（FileSystem 等都在 v2）
const { v2: webdav } = require('webdav-server');
const { FileSystem, ResourceType, Errors, LocalPropertyManager, LocalLockManager } = webdav;

const asy = require('./asy-cli');
const { errText } = require('./util');

const { parseAuthEntries } = asy;

/**
 * ondup（重名策略）的**实测**语义 —— 这是 scripts/probe-ondup.js 对真实云盘
 * 做对照实验得出的，和 asy-cli 文档里写的（"1 = 覆盖"）不一致：
 *   0     非法（HTTP 400 参数不合法）
 *   1     拒绝同名（HTTP 403 存在同类型的同名文件名）
 *   2     保留两者 / 自动改名（新文件叫 "name (2).ext"）
 *   3     覆盖（原文件被替换）
 *   4+    非法（HTTP 400）
 * 所以：PUT 覆盖必须用 3；想「绝不覆盖」就用 2。
 */
const ONDUP = {
  REFUSE: 1,
  KEEP_BOTH: 2,
  OVERWRITE: 3,
};

// ---------------------------------------------------------------- 工具

/** 把云盘/网络错误映射成 webdav-server 认识的 Errors.*（决定 HTTP 状态码） */
function mapError(e) {
  if (!e) return Errors.InvalidOperation;
  if (e.__isWebdavError) return e;

  const msg = errText(e);
  const status = e.status || (e.data && e.data.status);

  if (status === 404) return Errors.ResourceNotFound;
  if (status === 403) return Errors.Forbidden;
  if (status === 409) return Errors.ResourceAlreadyExists;
  if (status === 507) return Errors.InsufficientStorage;

  // 云盘业务错误码（code）里挑几个明确的
  const code = e.data && e.data.code;
  if (code === 404001001 || code === 404001002) return Errors.ResourceNotFound;
  if (/不存在|not found|NotFound/i.test(msg)) return Errors.ResourceNotFound;
  if (/已存在|already exists|AlreadyExists/i.test(msg)) return Errors.ResourceAlreadyExists;
  if (/没有权限|forbidden|permission denied/i.test(msg)) return Errors.Forbidden;

  return Errors.InvalidOperation;
}

function httpModuleFor(u) {
  return u.protocol === 'http:' ? http : https;
}

function portFor(u) {
  if (u.port) return u.port;
  return u.protocol === 'http:' ? 80 : 443;
}

/** 序列化器：本文件系统的状态都在云端，不需要持久化 */
class NoopSerializer {
  uid() {
    return 'AnyShareFSSerializer-1.0.0';
  }
  serialize(_fs, callback) {
    callback(null, {});
  }
  unserialize(_data, callback) {
    callback(null, null);
  }
}

// ---------------------------------------------------------------- 上传流
/**
 * 流式上传：body 直接转发到对象存储直链，不落本地磁盘。
 * 生命周期：_write 转发分片 -> _final 结束请求 -> 等响应 -> osendupload -> cb
 */
class StreamUpload extends Writable {
  constructor({ begin, client, fileName, size, log }) {
    super();
    this.begin = begin;
    this.client = client;
    this.fileName = fileName;
    this.size = size;
    this.log = log || (() => {});

    this.started = false;
    this.settled = false;
    this.statusCode = 0;
    this.resBody = Buffer.alloc(0);
    this.upstreamError = null;
    this._finalCb = null;
    this._writeCb = null;
    this._req = null;

    const isPost = begin.method === 'POST';
    if (isPost) {
      // multipart/form-data：服务端要求把 authrequest 里的 form 字段一起带上
      const boundary = '----asywebdav' + crypto.randomBytes(8).toString('hex');
      const fieldName = 'file';
      const contentType =
        begin.headers['Content-Type'] || begin.form['Content-Type'] || 'application/octet-stream';
      const parts = [];
      for (const [k, v] of Object.entries(begin.form)) {
        if (/content-type/i.test(k)) continue;
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${String(k).replace(/"/g, '\\"')}"\r\n\r\n${v}\r\n`
          )
        );
      }
      const fileHeader = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName.replace(
          /"/g,
          '\\"'
        )}"\r\nContent-Type: ${contentType}\r\n\r\n`
      );
      this.prefix = Buffer.concat(parts.concat([fileHeader]));
      this.tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      this.headers = Object.assign({}, begin.headers, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      });
      this.contentLength = this.prefix.length + size + this.tail.length;
    } else {
      this.prefix = null;
      this.tail = null;
      this.headers = Object.keys(begin.headers).length
        ? Object.assign({}, begin.headers)
        : Object.assign({}, begin.form);
      if (!this.headers['Content-Type'] && !this.headers['content-type']) {
        this.headers['Content-Type'] = 'application/octet-stream';
      }
      this.contentLength = size;
    }

    this.headers['Content-Length'] = String(this.contentLength);
    this._openUpstream();
  }

  _openUpstream() {
    const u = new URL(this.begin.url);
    const mod = httpModuleFor(u);
    const req = mod.request(
      {
        method: this.begin.method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: portFor(u),
        path: u.pathname + u.search,
        headers: this.headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          this.statusCode = res.statusCode;
          this.resBody = Buffer.concat(chunks);
          this._settleUpstream();
        });
      }
    );

    req.on('error', (e) => {
      this.upstreamError = e;
      // 写分片过程中出错：把错误交回 _write，让流走 error 分支
      if (this._writeCb) {
        const cb = this._writeCb;
        this._writeCb = null;
        this.settled = true;
        cb(e);
        return;
      }
      this._settleUpstream();
    });

    this._req = req;
  }

  /** 上游请求彻底结束（成功或失败） */
  _settleUpstream() {
    this.settled = true;
    const cb = this._finalCb;
    if (!cb) return; // _final 还没被调用，等它
    this._finalCb = null;
    this._complete(cb);
  }

  _complete(cb) {
    if (this.upstreamError) return cb(this.upstreamError);
    if (this.statusCode >= 400) {
      return cb(
        new Error(
          `上传到对象存储失败: HTTP ${this.statusCode} ${this.resBody.toString().slice(0, 300)}`
        )
      );
    }
    // 关键：必须等 osendupload 成功，文件才真正出现在云盘目录里
    this.client.endUpload(this.begin.docid, this.begin.rev, this.begin.csflevel).then(
      () => cb(null),
      (e) => cb(e)
    );
  }

  _write(chunk, encoding, callback) {
    if (!this.started) {
      this.started = true;
      if (this.prefix) this._req.write(this.prefix);
    }
    this._writeCb = callback;
    this._req.write(chunk, encoding, () => {
      if (this._writeCb === callback) this._writeCb = null;
      callback();
    });
  }

  _final(callback) {
    this._finalCb = callback;
    if (this.settled) {
      this._finalCb = null;
      return this._complete(callback);
    }
    if (this.prefix) this._req.end(this.tail);
    else this._req.end();
  }

  _destroy(err, callback) {
    try {
      if (this._req && !this._req.destroyed && !this.settled) this._req.destroy();
    } catch {
      /* ignore */
    }
    callback(err);
  }
}

/**
 * 未知长度（chunked PUT）时的退路：先落临时文件，再走 asy-cli 的 uploadFile。
 * 只在客户端没给 Content-Length 时才会用到（含 0 字节文件）。
 */
class BufferedUpload extends Writable {
  constructor({ client, parentDocid, fileName, ondup, tmpDir }) {
    super();
    this.client = client;
    this.parentDocid = parentDocid;
    this.fileName = fileName;
    this.ondup = ondup;
    this.tmpPath = path.join(tmpDir, `asy-webdav-${crypto.randomBytes(8).toString('hex')}.tmp`);
    this.out = fs.createWriteStream(this.tmpPath);
    this.bytes = 0;
  }

  _write(chunk, encoding, callback) {
    this.bytes += chunk.length;
    this.out.write(chunk, encoding, callback);
  }

  _final(callback) {
    this.out.end(() => {
      const cleanup = () => fs.unlink(this.tmpPath, () => {});
      // uploadFile 内部会 statSync 取长度，并用文件 mtime 作为 client_mtime
      asy.uploadFile(this.client.api, this.tmpPath, this.parentDocid, this.fileName, {
        ondup: this.ondup,
      }).then(
        () => {
          cleanup();
          callback(null);
        },
        (e) => {
          cleanup();
          callback(e);
        }
      );
    });
  }

  _destroy(err, callback) {
    try {
      this.out.destroy();
    } catch {
      /* ignore */
    }
    fs.unlink(this.tmpPath, () => callback(err));
  }
}

// ---------------------------------------------------------------- FileSystem
class AnyShareFileSystem extends FileSystem {
  /**
   * @param {import('./client').AnyShareClient} client
   * @param {object} [opts]
   * @param {number} [opts.ondup]    上传重名策略（实测语义见下），默认 3
   * @param {string} [opts.tmpDir]   未知长度上传的临时目录
   * @param {Function} [opts.log]
   */
  constructor(client, opts = {}) {
    super(new NoopSerializer());
    this.doNotSerialize(); // 状态都在云端，不需要持久化
    this.client = client;
    this.ondup = opts.ondup === undefined ? ONDUP.OVERWRITE : Number(opts.ondup);
    this.tmpDir = opts.tmpDir || os.tmpdir();
    this.log = opts.log || (() => {});
    this._props = new Map();
    this._locks = new Map();
  }

  // -------- 内存属性 / 锁（按路径惰性创建，和 PhysicalFileSystem 一致） --------
  _resourceMap(map, key, Ctor) {
    let v = map.get(key);
    if (!v) {
      v = new Ctor();
      map.set(key, v);
    }
    return v;
  }

  /** 统一收口错误：打日志 + 映射成 webdav-server 的 Errors.* */
  _fail(where, e, callback) {
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : errText(e);
    this.log('error', `${where} 失败: ${detail}`);
    callback(mapError(e));
  }

  _lockManager(path, _ctx, callback) {
    callback(null, this._resourceMap(this._locks, path.toString(), LocalLockManager));
  }

  _propertyManager(path, _ctx, callback) {
    callback(null, this._resourceMap(this._props, path.toString(), LocalPropertyManager));
  }

  // ------------------------------------------------------------ 只读
  _type(path, _ctx, callback) {
    this.client
      .resolveEntry(path.toString())
      .then((entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        callback(null, entry.type === 'dir' ? ResourceType.Directory : ResourceType.File);
      })
      .catch((e) => this._fail('_type', e, callback));
  }

  _readDir(path, _ctx, callback) {
    this.client
      .listDir(path.toString())
      .then((map) => {
        if (!map) return callback(Errors.ResourceNotFound);
        callback(null, Array.from(map.keys()));
      })
      .catch((e) => this._fail('_readDir', e, callback));
  }

  _size(path, _ctx, callback) {
    this.client
      .resolveEntry(path.toString())
      .then((entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        // 目录不给 size（云盘里是 -1），返回 0 免得 Content-Length 变负
        callback(null, entry.type === 'dir' ? 0 : entry.size);
      })
      .catch((e) => this._fail('_size', e, callback));
  }

  _lastModifiedDate(path, _ctx, callback) {
    this.client
      .resolveEntry(path.toString())
      .then((entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        callback(null, entry.mtime || Date.now());
      })
      .catch((e) => this._fail('_lastModifiedDate', e, callback));
  }

  _creationDate(path, _ctx, callback) {
    this.client
      .resolveEntry(path.toString())
      .then((entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        callback(null, entry.ctime || entry.mtime || Date.now());
      })
      .catch((e) => this._fail('_creationDate', e, callback));
  }

  _etag(path, _ctx, callback) {
    this.client
      .resolveEntry(path.toString())
      .then((entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        const raw =
          entry.rev ||
          crypto.createHash('md5').update(`${entry.mtime}|${entry.size}`).digest('hex');
        callback(null, `"${raw}"`);
      })
      .catch((e) => this._fail('_etag', e, callback));
  }

  _openReadStream(path, _ctx, callback) {
    const p = path.toString();
    this.client
      .resolveEntry(p)
      .then(async (entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        if (entry.type !== 'file') return callback(Errors.ResourceNotFound);

        const dl = await this.client.openDownload(entry);
        const u = new URL(dl.url);
        const mod = httpModuleFor(u);
        const headers = Object.assign({ 'User-Agent': 'asy-webdav/0.1' }, dl.headers);

        const req = mod.request(
          {
            method: dl.method || 'GET',
            protocol: u.protocol,
            hostname: u.hostname,
            port: portFor(u),
            path: u.pathname + u.search,
            headers,
          },
          (res) => {
            if (res.statusCode >= 400) {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const msg = `osdownload 直链返回 HTTP ${res.statusCode} ${Buffer.concat(chunks)
                  .toString()
                  .slice(0, 200)}`;
                this.log('error', `GET ${p} 失败: ${msg}`);
                callback(mapError(new Error(msg)));
              });
              return;
            }
            callback(null, res);
          }
        );
        req.on('error', (e) => this._fail('_openReadStream', e, callback));
        req.end();
      })
      .catch((e) => this._fail('_openReadStream', e, callback));
  }

  // ------------------------------------------------------------ 创建
  _create(path, ctx, callback) {
    const p = path.toString();
    const name = path.fileName();

    if (!ctx.type || !ctx.type.isDirectory) {
      // PUT 新文件的路径：这里什么都不做，真正的创建在 _openWriteStream。
      // （webdav-server 的 create() 已经校验过父目录存在且是目录）
      return callback(null);
    }

    this.client
      .resolveEntry(path.getParent().toString())
      .then(async (parent) => {
        if (!parent) return callback(Errors.IntermediateResourceMissing);
        if (parent.type !== 'dir') return callback(Errors.WrongParentTypeForCreation);

        const existing = await this.client.resolveEntry(p);
        if (existing) return callback(Errors.ResourceAlreadyExists);

        const docid = await this.client.mkdir(parent.docid, name);
        this.client.invalidate(p);
        this.client.prime(p, {
          docid,
          name,
          type: 'dir',
          size: 0,
          mtime: Date.now(),
          ctime: Date.now(),
          rev: '',
        });
        this.log('info', `MKCOL ${p}`);
        callback(null);
      })
      .catch((e) => this._fail('_create', e, callback));
  }

  // ------------------------------------------------------------ 上传
  _openWriteStream(path, ctx, callback) {
    const p = path.toString();
    const name = path.fileName();
    const parentPath = path.getParent().toString();
    const estimated = ctx && ctx.estimatedSize;
    const known = Number.isFinite(estimated) && estimated > 0;

    this.client
      .resolveEntry(parentPath)
      .then(async (parent) => {
        if (!parent) return callback(Errors.IntermediateResourceMissing);
        if (parent.type !== 'dir') return callback(Errors.WrongParentTypeForCreation);

        const existing = await this.client.resolveEntry(p);
        if (existing && existing.type === 'dir') return callback(Errors.Forbidden);

        if (known) {
          const begin = await this.client.beginUpload(parent.docid, name, estimated, this.ondup);
          const stream = new StreamUpload({
            begin,
            client: this.client,
            fileName: name,
            size: estimated,
            log: this.log,
          });
          this.log('info', `PUT ${p} (${estimated} B, 流式 ${begin.method})`);
          stream.on('finish', () => this.client.invalidate(p));
          stream.on('error', (e) => this.log('error', `PUT ${p} 流式上传失败: ${errText(e)}`));
          return callback(null, stream);
        }

        // 没有 Content-Length（chunked）或 0 字节：先落临时文件
        const stream = new BufferedUpload({
          client: this.client,
          parentDocid: parent.docid,
          fileName: name,
          ondup: this.ondup,
          tmpDir: this.tmpDir,
        });
        this.log('info', `PUT ${p} (长度未知，走临时文件中转)`);
        stream.on('finish', () => this.client.invalidate(p));
        stream.on('error', (e) => this.log('error', `PUT ${p} 中转上传失败: ${errText(e)}`));
        callback(null, stream);
      })
      .catch((e) => this._fail('_openWriteStream', e, callback));
  }

  // ------------------------------------------------------------ 删除
  _delete(path, ctx, callback) {
    const p = path.toString();
    if (p === '/') return callback(Errors.Forbidden); // 不允许删掉 WebDAV 根

    this.client
      .resolveEntry(p)
      .then(async (entry) => {
        if (!entry) return callback(Errors.ResourceNotFound);
        if (entry.type === 'dir' && ctx.depth === 0) await this.client.remove(entry);
        else await this.client.removeRecursive(entry);
        this.client.invalidate(p);
        this.log('info', `DELETE ${p}`);
        callback(null);
      })
      .catch((e) => this._fail('_delete', e, callback));
  }

  // ------------------------------------------------------------ 移动 / 复制
  /**
   * MOVE 与 COPY 共用的实现。
   *
   * 云盘的 copy/move 只能给 (docid, destparent, ondup)，**不能同时指定新名字**。
   * 所以「跨目录 + 改名」这类操作只能分两步走。这里有个很隐蔽的坑：
   * 如果直接用 ondup=1 复制到目标目录，而目标目录里恰好已经有一个和**源文件同名的
   * 对象**（同目录改名时就是源文件自己！），ondup=1 会把它覆盖掉 —— 等于把源文件删了。
   *
   * 因此统一策略：
   *   1. 先用 ondup=2（自动改名，绝不覆盖任何已有对象）执行
   *   2. 对比操作前后的目录列举，用差集找出新产生的那一项
   *   3. 需要改名就单独调一次 rename
   * 这样不管服务端的自动改名规则是什么（"a (1).txt" / "a_1.txt" ...）都能对上。
   */
  _transfer(kind, pathFrom, pathTo, ctx, callback) {
    const where = kind === 'move' ? '_move' : '_copy';
    const from = pathFrom.toString();
    const to = pathTo.toString();

    if (from === '/' || to === '/' || from === to) return callback(Errors.Forbidden);

    this.client
      .resolveEntry(from)
      .then(async (src) => {
        if (!src) return callback(Errors.ResourceNotFound);

        const destParentPath = pathTo.getParent().toString();
        const srcParentPath = pathFrom.getParent().toString();
        const destName = pathTo.fileName();
        const destParent = await this.client.resolveEntry(destParentPath);
        if (!destParent) return callback(Errors.IntermediateResourceMissing);
        if (destParent.type !== 'dir') return callback(Errors.WrongParentTypeForCreation);

        const dest = await this.client.resolveEntry(to);
        if (dest && !ctx.overwrite) return callback(Errors.ResourceAlreadyExists);

        let overwritten = false;
        if (dest) {
          await this.client.removeRecursive(dest);
          overwritten = true;
        }

        // 同目录改名：云盘的 move 会报「403 对象无法移动到相同的路径或者子路径」，
        // 所以这一种情况必须直接走 rename。dest 已在上面删掉，目标名是空的。
        if (kind === 'move' && destParentPath === srcParentPath) {
          await this.client.renameInto(src.docid, destName);
          this.client.invalidate(from);
          this.client.invalidate(to);
          this.log('info', `MOVE ${from} -> ${to}（同目录，走 rename）`);
          return callback(null, overwritten);
        }

        // 操作前先记下目标目录里已有的名字（强制拿最新列举）
        this.client.invalidate(destParentPath);
        const before = await this.client.listDir(destParentPath);
        const beforeNames = new Set(before ? before.keys() : []);

        if (kind === 'move') await this.client.move(src.docid, destParent.docid, ONDUP.KEEP_BOTH);
        else await this.client.copy(src.docid, destParent.docid, ONDUP.KEEP_BOTH);

        this.client.invalidate(destParentPath);
        const after = await this.client.listDir(destParentPath);

        let created = null;
        if (after) {
          for (const [name, e] of after) {
            if (!beforeNames.has(name)) {
              created = e;
              break;
            }
          }
          // 差集没命中（例如服务端没改名）：退回按源名字找
          if (!created) created = after.get(src.name) || null;
        }
        if (!created) throw new Error('无法在目标目录定位复制/移动产生的新条目');

        if (created.name !== destName) {
          // rename 只接受 ondup=1，目标名必须空着（dest 已在上面删掉了）
          await this.client.renameInto(created.docid, destName);
        }

        this.client.invalidate(from);
        this.client.invalidate(to);
        this.client.invalidate(destParentPath);
        this.log('info', `${kind === 'move' ? 'MOVE' : 'COPY'} ${from} -> ${to}`);
        callback(null, overwritten);
      })
      .catch((e) => this._fail(where, e, callback));
  }

  _move(pathFrom, pathTo, ctx, callback) {
    this._transfer('move', pathFrom, pathTo, ctx, callback);
  }

  _copy(pathFrom, pathTo, ctx, callback) {
    this._transfer('copy', pathFrom, pathTo, ctx, callback);
  }

  _rename(pathFrom, newName, ctx, callback) {
    const pathTo = pathFrom.getParent().getChildPath(newName);
    this._transfer('move', pathFrom, pathTo, ctx, callback);
  }
}

module.exports = {
  AnyShareFileSystem,
  StreamUpload,
  BufferedUpload,
  mapError,
  NoopSerializer,
  ONDUP,
};
