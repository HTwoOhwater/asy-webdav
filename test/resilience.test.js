'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { AnyShareClient } = require('../lib/client');
const { mapError } = require('../lib/anyshare-fs');
const { v2: webdav } = require('webdav-server');

function transient(status = 504) {
  return Object.assign(new Error('temporary upstream failure'), {
    status,
    data: { code: status === 504 ? 'ASY_REQUEST_TIMEOUT' : 'ASY_NETWORK_ERROR' },
  });
}

test('只读 API 遇到瞬时失败会重试', async () => {
  let calls = 0;
  const api = {
    call: async () => {
      calls++;
      if (calls === 1) throw transient();
      return { ok: true };
    },
  };
  const client = new AnyShareClient({ api, readRetries: 1, log: () => {} });

  assert.deepStrictEqual(await client.api.call('GET', '/read'), { ok: true });
  assert.strictEqual(calls, 2);
  assert.strictEqual(client.stats.retries, 1);
});

test('写 API 遇到瞬时失败不会重试', async () => {
  let calls = 0;
  const api = {
    call: async () => {
      calls++;
      throw transient(503);
    },
  };
  const client = new AnyShareClient({ api, readRetries: 2, log: () => {} });

  await assert.rejects(client.api.call('POST', '/efast/v1/dir/create'), { status: 503 });
  assert.strictEqual(calls, 1);
});

test('并发列举同一目录会合并为一次上游请求', async () => {
  let listCalls = 0;
  const api = {
    call: async () => {},
    resolvePath: async () => ({ docid: 'root' }),
    listFolder: async () => {
      listCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { dirs: [], files: [] };
    },
  };
  const client = new AnyShareClient({ api, basePath: '/', log: () => {} });

  await Promise.all([client.listDir('/'), client.listDir('/'), client.listDir('/')]);
  assert.strictEqual(listCalls, 1);
  assert.strictEqual(client.stats.coalesced, 2);
});

test('上游网络错误和超时映射为 WebDAV 503/504', () => {
  const unavailable = mapError(transient(503));
  const timeout = mapError(transient(504));
  assert.strictEqual(webdav.HTTPRequestContext.defaultStatusCode(unavailable), 503);
  assert.strictEqual(webdav.HTTPRequestContext.defaultStatusCode(timeout), 504);
});
