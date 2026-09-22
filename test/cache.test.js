'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { test } = require('node:test');
const assert = require('node:assert');

const { MetadataStore, ContentCache } = require('../lib/cache');
const { AnyShareClient } = require('../lib/client');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asy-webdav-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待缓存写入超时');
}

test('元数据快照在进程重启后仍可读取', (t) => {
  const file = path.join(tmpDir(t), 'metadata.json');
  const root = { docid: 'root', name: '', type: 'dir', size: 0, rev: '' };
  const child = { docid: 'file-1', name: 'a.md', type: 'file', size: 3, rev: 'r1' };
  const first = new MetadataStore(file, 300000);
  first.setRoot(root);
  first.setListing('/', new Map([['a.md', child]]));

  const reopened = new MetadataStore(file, 300000);
  assert.deepStrictEqual(reopened.getRoot().value, root);
  assert.deepStrictEqual(reopened.getListing('/').value.get('a.md'), child);
  assert.strictEqual(reopened.getListing('/').fresh, true);
});

test('新鲜持久化目录直接响应，不调用云端 API', async (t) => {
  const store = new MetadataStore(path.join(tmpDir(t), 'metadata.json'), 300000);
  store.setListing('/', new Map([
    ['cached.md', { docid: 'f1', name: 'cached.md', type: 'file', size: 4, rev: 'r1' }],
  ]));
  let cloudCalls = 0;
  const api = {
    call: async () => {},
    resolvePath: async () => { cloudCalls++; throw new Error('不应调用'); },
    listFolder: async () => { cloudCalls++; throw new Error('不应调用'); },
  };
  const client = new AnyShareClient({ api, metadataStore: store, log: () => {} });

  const listing = await client.listDir('/');
  assert.ok(listing.has('cached.md'));
  assert.strictEqual(cloudCalls, 0);
  assert.strictEqual(client.stats.persistentHits, 1);
});

test('过期目录回源失败时使用最后一次成功快照', async (t) => {
  const file = path.join(tmpDir(t), 'metadata.json');
  const store = new MetadataStore(file, 1000);
  store.setRoot({ docid: 'root', name: '', type: 'dir', size: 0, rev: '' });
  store.setListing('/', new Map([
    ['stale.md', { docid: 'f1', name: 'stale.md', type: 'file', size: 4, rev: 'r1' }],
  ]));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.listings['/'].fetchedAt = Date.now() - 5000;
  fs.writeFileSync(file, JSON.stringify(data));
  const staleStore = new MetadataStore(file, 1000);
  const api = {
    call: async () => {},
    resolvePath: async () => ({ docid: 'root' }),
    listFolder: async () => { throw Object.assign(new Error('timeout'), { status: 504 }); },
  };
  const client = new AnyShareClient({ api, metadataStore: staleStore, readRetries: 0, log: () => {} });

  const listing = await client.listDir('/');
  assert.ok(listing.has('stale.md'));
  assert.strictEqual(client.stats.staleFallbacks, 1);
});

test('目录树失效会清除所有后代的持久化元数据', (t) => {
  const file = path.join(tmpDir(t), 'metadata.json');
  const store = new MetadataStore(file, 300000);
  store.setListing('/vault', new Map());
  store.setListing('/vault/notes', new Map());
  store.setListing('/other', new Map());
  const client = new AnyShareClient({ api: { call: async () => {} }, metadataStore: store, log: () => {} });

  client.invalidateTree('/vault');
  const reopened = new MetadataStore(file, 300000);
  assert.strictEqual(reopened.getListing('/vault'), null);
  assert.strictEqual(reopened.getListing('/vault/notes'), null);
  assert.ok(reopened.getListing('/other'));
});

test('内容缓存按 docid + rev 命中并拒绝长度不符的文件', async (t) => {
  const dir = tmpDir(t);
  const cache = new ContentCache(dir, 1024);
  const entry = { docid: 'f1', rev: 'r1', size: 5 };

  const first = cache.capture(entry, Readable.from([Buffer.from('hello')]));
  assert.strictEqual((await readAll(first)).toString(), 'hello');
  await waitFor(() => cache.stats.writes === 1);
  assert.strictEqual((await readAll(cache.open(entry))).toString(), 'hello');
  assert.strictEqual(cache.stats.hits, 1);

  const badEntry = { docid: 'f1', rev: 'r1', size: 6 };
  assert.strictEqual(cache.open(badEntry), null);
});

test('内容缓存超过容量后淘汰最久未使用的文件', async (t) => {
  const cache = new ContentCache(tmpDir(t), 6);
  const a = { docid: 'a', rev: '1', size: 4 };
  const b = { docid: 'b', rev: '1', size: 4 };
  await readAll(cache.capture(a, Readable.from([Buffer.from('aaaa')])));
  await waitFor(() => cache.stats.writes === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await readAll(cache.capture(b, Readable.from([Buffer.from('bbbb')])));
  await waitFor(() => cache.stats.writes === 2);
  await cache.prune();

  assert.strictEqual(cache.open(a), null);
  assert.strictEqual((await readAll(cache.open(b))).toString(), 'bbbb');
});
