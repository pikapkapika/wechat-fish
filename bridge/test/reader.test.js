import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../src/reader.js';

const baseUrl = 'http://reader.invalid';
const token = 'reader-test-token';
const routes = [
  ['status', [], '/api/v1/reader/status'],
  ['sessions', [], '/api/v1/sessions?limit=500'],
  ['contacts', [], '/api/v1/contacts'],
  ['stickers', ['wechat:group:12 &x'], '/api/v1/stickers?conversationKey=wechat%3Agroup%3A12%20%26x'],
];
for (const [method, args, route] of routes) {
  test(`Reader ${method}: parsed JSON, URL, auth, GET`, async () => {
    const payload = { success: true, items: [1] };
    const reader = createReader({ baseUrl: baseUrl + '/', token, fetchImpl: async (url, options) => {
      assert.equal(url, baseUrl + route);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.body, undefined);
      return Response.json(payload);
    } });
    assert.deepEqual(await reader[method](...args), payload);
  });
  test(`Reader ${method}: non-2xx includes route and status`, async () => {
    const reader = createReader({ baseUrl, token, fetchImpl: async () => new Response('', { status: 503 }) });
    await assert.rejects(reader[method](...args), error => error.message.includes(route) && error.message.includes('503'));
  });
  test(`Reader ${method}: network failure`, async () => {
    const error = new Error('offline');
    const reader = createReader({ baseUrl, token, fetchImpl: async () => { throw error; } });
    await assert.rejects(reader[method](...args), error);
  });
}
test('Reader push: SSE JSON, heartbeat, split UTF-8, queued events, no invented cursor', async () => {
  let calls = 0;
  const reader = createReader({ baseUrl, token, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, baseUrl + '/api/v1/push/messages');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const bytes = new TextEncoder().encode(': heartbeat\n\ndata: {"rawid":"a","content":"你好"}\n\ndata: {"rawid":"b"}\r\n\r\n');
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  } });
  assert.deepEqual(await Promise.all([reader.push({ since: 'ignored' }), reader.push({ since: 'a' })]), [
    { rawid: 'a', content: '你好' }, { rawid: 'b' },
  ]);
  assert.equal(calls, 1);
  await assert.rejects(reader.push({}), /SSE stream ended/);
});
test('Reader push: HTTP, network and invalid content type failures', async () => {
  for (const [fetchImpl, pattern] of [
    [async () => new Response('', { status: 401 }), /\/api\/v1\/push\/messages: HTTP 401/],
    [async () => { throw new Error('offline'); }, /offline/],
    [async () => Response.json({}), /expected text\/event-stream/],
  ]) {
    await assert.rejects(createReader({ baseUrl, token, fetchImpl }).push({}), pattern);
  }
});
