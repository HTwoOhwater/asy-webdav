'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

class MetadataStore {
  constructor(filePath, maxAgeMs, log = () => {}) {
    this.filePath = filePath;
    this.maxAgeMs = Math.max(1000, Number(maxAgeMs) || 300000);
    this.log = log;
    this.data = { version: 1, root: null, listings: {} };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.listings) this.data = parsed;
    } catch (e) {
      this.log('warn', `元数据缓存读取失败，将重新建立: ${e.message}`);
    }
  }

  _save() {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(tmp, this.filePath);
      } catch (e) {
        if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
        fs.unlinkSync(this.filePath);
        fs.renameSync(tmp, this.filePath);
      }
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能尚未创建 */
      }
      this.log('warn', `元数据缓存写入失败: ${e.message}`);
    }
  }

  _result(record) {
    if (!record) return null;
    return {
      value: record.value,
      fresh: Date.now() - Number(record.fetchedAt || 0) <= this.maxAgeMs,
    };
  }

  getRoot() {
    return this._result(this.data.root);
  }

  setRoot(entry) {
    this.data.root = { fetchedAt: Date.now(), value: entry };
    this._save();
  }

  getListing(p) {
    const result = this._result(this.data.listings[p]);
    if (!result || !Array.isArray(result.value)) return null;
    result.value = new Map(result.value.map((entry) => [entry.name, entry]));
    return result;
  }

  setListing(p, listing) {
    this.data.listings[p] = {
      fetchedAt: Date.now(),
      value: Array.from(listing.values()),
    };
    this._save();
  }

  invalidate(...paths) {
    let changed = false;
    for (const p of paths) {
      if (Object.prototype.hasOwnProperty.call(this.data.listings, p)) {
        delete this.data.listings[p];
        changed = true;
      }
    }
    if (changed) this._save();
  }

  invalidateTree(prefix) {
    const childPrefix = prefix === '/' ? '/' : `${prefix}/`;
    let changed = false;
    for (const key of Object.keys(this.data.listings)) {
      if (key === prefix || key.startsWith(childPrefix)) {
        delete this.data.listings[key];
        changed = true;
      }
    }
    if (changed) this._save();
  }

  clear() {
    this.data = { version: 1, root: null, listings: {} };
    this._save();
  }
}

class ContentCache {
  constructor(dir, maxBytes, log = () => {}) {
    this.dir = dir;
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.log = log;
    this.stats = { hits: 0, misses: 0, writes: 0 };
    if (this.maxBytes > 0) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  _path(entry) {
    if (!entry || !entry.docid || !entry.rev) return null;
    const key = crypto.createHash('sha256').update(`${entry.docid}\0${entry.rev}`).digest('hex');
    return path.join(this.dir, `${key}.cache`);
  }

  open(entry) {
    const file = this._path(entry);
    if (!file || this.maxBytes <= 0) return null;
    try {
      const stat = fs.statSync(file);
      if (stat.size !== Number(entry.size)) {
        fs.unlinkSync(file);
        this.stats.misses++;
        return null;
      }
      const now = new Date();
      fs.utimes(file, now, now, () => {});
      this.stats.hits++;
      return fs.createReadStream(file);
    } catch {
      this.stats.misses++;
      return null;
    }
  }

  capture(entry, source) {
    const target = this._path(entry);
    if (!target || this.maxBytes <= 0 || Number(entry.size) > this.maxBytes) return source;

    const output = new PassThrough();
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const writer = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    let cacheFailed = false;

    writer.on('error', (e) => {
      cacheFailed = true;
      this.log('warn', `内容缓存写入失败: ${e.message}`);
      fs.unlink(tmp, () => {});
    });
    writer.on('finish', () => {
      if (cacheFailed) return;
      fs.stat(tmp, (statError, stat) => {
        if (statError || stat.size !== Number(entry.size)) {
          fs.unlink(tmp, () => {});
          return;
        }
        fs.rename(tmp, target, (renameError) => {
          if (renameError) {
            fs.unlink(tmp, () => {});
            this.log('warn', `内容缓存提交失败: ${renameError.message}`);
            return;
          }
          this.stats.writes++;
          this.prune();
        });
      });
    });
    source.on('error', (e) => {
      writer.destroy(e);
      output.destroy(e);
    });
    source.pipe(writer);
    source.pipe(output);
    return output;
  }

  async prune() {
    try {
      const names = await fs.promises.readdir(this.dir);
      const records = [];
      let total = 0;
      for (const name of names) {
        if (!name.endsWith('.cache')) continue;
        const file = path.join(this.dir, name);
        const stat = await fs.promises.stat(file);
        records.push({ file, size: stat.size, atimeMs: stat.atimeMs });
        total += stat.size;
      }
      records.sort((a, b) => a.atimeMs - b.atimeMs);
      for (const record of records) {
        if (total <= this.maxBytes) break;
        await fs.promises.unlink(record.file);
        total -= record.size;
      }
    } catch (e) {
      this.log('warn', `内容缓存清理失败: ${e.message}`);
    }
  }
}

module.exports = { MetadataStore, ContentCache };
