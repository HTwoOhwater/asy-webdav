// ============================================================================
// asy-webdav - 测试用「假云盘」：内存版 AnyShare API + 假对象存储
// ----------------------------------------------------------------------------
// 目的：在没有学校账号/网络的情况下，端到端验证 webdav-server 契约。
// 行为刻意模仿实测到的真实 API：
//   * 目录的 size === -1
//   * 条目字段是 id / name / size / rev / modified_at / created_at
//   * 删除非空目录会被拒绝（用来验证递归删除退路）
//   * 上传是两阶段：osbeginupload -> 直传对象存储 -> osendupload
// ============================================================================

'use strict';

const http = require('http');
const fs = require('fs');

// ---------------------------------------------------------------- 假对象存储
function extractMultipartFile(body, boundary) {
  const delim = Buffer.from('--' + boundary);
  let start = body.indexOf(delim);
  while (start !== -1) {
    const next = body.indexOf(delim, start + delim.length);
    if (next === -1) break;
    const part = body.slice(start + delim.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = part.slice(0, headerEnd).toString('latin1');
      if (/name="file"/.test(header) && /filename=/.test(header)) {
        return part.slice(headerEnd + 4, part.length - 2); // 去掉尾部 \r\n
      }
    }
    start = next;
  }
  return Buffer.alloc(0);
}

async function startObjectStore() {
  const store = new Map();
  const log = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(req.url.replace(/^\/obj\//, '').split('?')[0]);
      log.push(`${req.method} ${key} ${body.length}`);

      if (req.method === 'GET') {
        if (!store.has(key)) {
          res.writeHead(404);
          return res.end('not found');
        }
        const buf = store.get(key);
        res.writeHead(200, {
          'Content-Length': String(buf.length),
          'Content-Type': 'application/octet-stream',
        });
        return res.end(buf);
      }
      if (req.method === 'PUT') {
        store.set(key, body);
        res.writeHead(200);
        return res.end('ok');
      }
      if (req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        const m = /boundary=(.+)$/.exec(ct);
        const file = m ? extractMultipartFile(body, m[1].replace(/^"|"$/g, '')) : body;
        store.set(key, file);
        res.writeHead(200);
        return res.end('ok');
      }
      res.writeHead(405);
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store,
    log,
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- 假 AnyShare API
class FakeApi {
  constructor(objBase, store) {
    this.objBase = objBase;
    this.store = store || new Map();
    this.nodes = new Map();
    this.kids = new Map();
    this.seq = 0;
    this.calls = [];
    this.pathCalls = new Map();
    this.rootDocid = this._add('', 'dir', null);
  }

  _bump(apiPath) {
    this.pathCalls.set(apiPath, (this.pathCalls.get(apiPath) || 0) + 1);
  }

  _id() {
    return 'gns://fake/' + (++this.seq).toString(16).padStart(8, '0');
  }

  _add(name, type, parent) {
    const docid = this._id();
    const now = new Date().toISOString();
    this.nodes.set(docid, {
      docid,
      name,
      type,
      parent,
      size: type === 'dir' ? -1 : 0,
      rev: 'rev' + (++this.seq).toString(16).padStart(4, '0'),
      mtime: now,
      ctime: now,
    });
    this.kids.set(docid, []);
    if (parent) this.kids.get(parent).push(docid);
    return docid;
  }

  _find(parentDocid, name) {
    for (const id of this.kids.get(parentDocid) || []) {
      const n = this.nodes.get(id);
      if (n.name === name) return n;
    }
    return null;
  }

  _raw(n) {
    return {
      id: n.docid,
      name: n.name,
      size: n.type === 'dir' ? -1 : n.size,
      rev: n.rev,
      modified_at: n.mtime,
      created_at: n.ctime,
    };
  }

  _detach(n) {
    const sib = this.kids.get(n.parent) || [];
    const i = sib.indexOf(n.docid);
    if (i !== -1) sib.splice(i, 1);
  }

  _dropSubtree(docid) {
    for (const id of this.kids.get(docid) || []) this._dropSubtree(id);
    this.nodes.delete(docid);
    this.kids.delete(docid);
  }

  _clone(srcDocid, parent) {
    const src = this.nodes.get(srcDocid);
    const copy = this._add(src.name, src.type, parent);
    const node = this.nodes.get(copy);
    node.size = src.size;
    node.rev = 'rev' + (++this.seq).toString(16).padStart(4, '0');
    if (src.type === 'dir') {
      for (const id of this.kids.get(srcDocid) || []) this._clone(id, copy);
    } else {
      const buf = this.store.get(srcDocid);
      this.store.set(copy, buf ? Buffer.from(buf) : Buffer.alloc(0));
    }
    return copy;
  }

  // ---- AnyShareClient 用到的接口 ----
  async resolvePath(p) {
    this._bump('resolvePath');
    const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean) {
      return { docid: this.rootDocid, name: '', type: 'dir', parent: null, raw: null };
    }
    const parts = clean.split('/').filter(Boolean);
    let cur = this.rootDocid;
    let parent = null;
    for (let i = 0; i < parts.length; i++) {
      const hit = this._find(cur, parts[i]);
      if (!hit) throw new Error('远程路径不存在: ' + parts.slice(0, i + 1).join('/'));
      parent = cur;
      cur = hit.docid;
      if (i === parts.length - 1) {
        return {
          docid: cur,
          name: hit.name,
          type: hit.type === 'dir' ? 'dir' : 'file',
          parent,
          raw: this._raw(hit),
        };
      }
    }
    return { docid: cur, name: parts[parts.length - 1], type: 'dir', parent, raw: null };
  }

  async listFolder(docid) {
    this._bump('sub_objects');
    if (!this.nodes.has(docid)) throw new Error('目录不存在');
    const dirs = [];
    const files = [];
    for (const id of this.kids.get(docid) || []) {
      const n = this.nodes.get(id);
      (n.type === 'dir' ? dirs : files).push(this._raw(n));
    }
    return { dirs, files };
  }

  async mkdir(parentDocid, name) {
    this._bump('dir/create');
    if (this._find(parentDocid, name)) throw new Error('同名目录已存在');
    return this._add(name, 'dir', parentDocid);
  }

  async remove(items) {
    for (const it of items) {
      this._bump(it.type === 'dir' ? 'dir/delete' : 'file/delete');
      const n = this.nodes.get(it.docid);
      if (!n) throw new Error('要删除的对象不存在');
      if (n.type === 'dir' && (this.kids.get(n.docid) || []).length > 0) {
        // 模仿真实 API：非空目录拒绝删除
        const err = new Error('目录非空，无法删除');
        err.status = 403;
        throw err;
      }
      this._detach(n);
      this._dropSubtree(n.docid);
    }
  }

  async rename(docid, name, ondup = 1) {
    this._bump('file/rename');
    const n = this.nodes.get(docid);
    if (!n) throw new Error('重命名目标不存在');
    // 实测：rename 不接受 ondup=3（会报「当前操作不支持覆盖」）
    if (Number(ondup) === 3) {
      const err = new Error('当前操作不支持覆盖。');
      err.status = 403;
      throw err;
    }
    const clash = this._find(n.parent, name);
    if (clash && clash.docid !== docid) {
      if (Number(ondup) === 1) {
        const err = new Error('存在同类型的同名文件名。');
        err.status = 403;
        throw err;
      }
      const err = new Error('rename 的 ondup=2 在真实云盘上会丢数据，测试桩直接拒绝');
      err.status = 403;
      throw err;
    }
    n.name = name;
    n.rev = 'rev' + (++this.seq).toString(16).padStart(4, '0');
    n.mtime = new Date().toISOString();
  }

  /** 模仿云盘的「自动改名」：name (1).ext */
  _autoName(parentDocid, name, excludeDocid) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      const hit = this._find(parentDocid, candidate);
      if (!hit || hit.docid === excludeDocid) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  async move(docid, destParentDocid, ondup = 1) {
    this._bump('file/move');
    const n = this.nodes.get(docid);
    if (!n) throw new Error('移动源不存在');
    // 实测：云盘不允许移动到相同的父目录（同目录改名必须走 rename）
    if (n.parent === destParentDocid) {
      const err = new Error('对象无法移动到相同的路径或者子路径。');
      err.status = 403;
      throw err;
    }
    const clash = this._find(destParentDocid, n.name);
    if (clash && clash.docid !== docid) {
      if (Number(ondup) === 1) {
        this._detach(clash);
        this._dropSubtree(clash.docid);
      } else if (Number(ondup) === 2) {
        n.name = this._autoName(destParentDocid, n.name, docid);
      } else {
        throw new Error('目标目录存在同名对象');
      }
    }
    this._detach(n);
    n.parent = destParentDocid;
    this.kids.get(destParentDocid).push(docid);
    n.rev = 'rev' + (++this.seq).toString(16).padStart(4, '0');
  }

  async copy(docid, destParentDocid, ondup = 1) {
    this._bump('file/copy');
    const n = this.nodes.get(docid);
    if (!n) throw new Error('复制源不存在');
    const clash = this._find(destParentDocid, n.name);
    if (clash && Number(ondup) === 1) {
      this._detach(clash);
      this._dropSubtree(clash.docid);
    } else if (clash && Number(ondup) !== 2) {
      throw new Error('目标目录存在同名对象');
    }
    const copyId = this._clone(docid, destParentDocid);
    if (clash && Number(ondup) === 2) {
      this.nodes.get(copyId).name = this._autoName(destParentDocid, n.name, copyId);
    }
    return copyId;
  }

  async call(method, apiPath, opts = {}) {
    this._bump(apiPath);
    if (apiPath === '/efast/v1/file/osbeginupload') {
      const j = opts.json;
      const parent = this.nodes.get(j.docid);
      if (!parent || parent.type !== 'dir') throw new Error('上传目标不是目录');
      let target = this._find(j.docid, j.name);
      if (target) {
        // 实测语义：1=拒绝同名，2=自动改名，3=覆盖
        if (Number(j.ondup) === 3) {
          // 覆盖，复用原节点
        } else if (Number(j.ondup) === 2) {
          const newName = this._autoName(j.docid, j.name, null);
          target = this.nodes.get(this._add(newName, 'file', j.docid));
        } else {
          const err = new Error('存在同类型的同名文件名。');
          err.status = 403;
          throw err;
        }
      } else {
        target = this.nodes.get(this._add(j.name, 'file', j.docid));
      }
      target.size = j.length;
      target.rev = 'rev' + (++this.seq).toString(16).padStart(4, '0');
      this._pendingUpload = { docid: target.docid, rev: target.rev };
      return {
        authrequest: [
          'PUT',
          `${this.objBase}/obj/${target.docid}`,
          'Authorization: fake-signature',
          'x-amz-date: fake-date',
        ],
        docid: target.docid,
        rev: target.rev,
        csflevel: 0,
      };
    }
    throw new Error('FakeApi 未实现的接口: ' + method + ' ' + apiPath);
  }

  async osbeginupload(folderDocid, filePath, fileName, ondup = 1) {
    const stat = fs.statSync(filePath);
    const data = await this.call('POST', '/efast/v1/file/osbeginupload', {
      json: {
        client_mtime: Math.floor(stat.mtimeMs),
        docid: folderDocid,
        length: stat.size,
        name: fileName,
        ondup: Number(ondup),
        reqmethod: 'POST',
      },
    });
    const req = data && data.authrequest;
    if (!Array.isArray(req) || req.length < 2) {
      throw new Error('authrequest 格式异常');
    }
    // 与 asy-cli 的 api.osbeginupload 返回结构保持一致
    return { data, method: req[0], url: req[1], entries: req.slice(2) };
  }

  async osendupload(docid, rev, csflevel = 0) {
    this._bump('osendupload');
    const n = this.nodes.get(docid);
    if (!n) throw new Error('osendupload 目标不存在');
    this.committed = docid;
    return { code: 0 };
  }

  async osdownload(docid, savename) {
    this._bump('osdownload');
    const n = this.nodes.get(docid);
    if (!n) throw new Error('下载目标不存在');
    const url = `${this.objBase}/obj/${docid}`;
    return {
      method: 'GET',
      url,
      entries: ['Authorization: fake-signature'],
      raw: { authrequest: ['GET', url, 'Authorization: fake-signature'] },
    };
  }

  // ---- 测试辅助 ----
  /** 在指定目录下直接放一个文件（模拟云盘里本来就有的文件） */
  addFile(parentPath, name, content) {
    const parent = this.nodeAt(parentPath);
    if (!parent || parent.type !== 'dir') throw new Error('父目录不存在: ' + parentPath);
    const docid = this._add(name, 'file', parent.docid);
    const node = this.nodes.get(docid);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
    this.store.set(docid, buf);
    node.size = buf.length;
    return node;
  }

  nodeAt(p) {
    const parts = String(p).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let cur = this.rootDocid;
    let node = this.nodes.get(cur);
    for (const part of parts) {
      const hit = this._find(cur, part);
      if (!hit) return null;
      node = hit;
      cur = hit.docid;
    }
    return node;
  }

  callsFor(apiPath) {
    return this.pathCalls.get(apiPath) || 0;
  }
}

module.exports = { startObjectStore, FakeApi, extractMultipartFile };
