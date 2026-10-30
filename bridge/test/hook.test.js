import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from '../src/hook.js';

const baseUrl = 'http://hook.invalid';
const token = 'native-test-token';

test('Hook health: native URL, auth, GET and parsed JSON', async () => {
  const payload = { ret: 0, nativeStickerSend: true };
  const hook = createHook({ baseUrl: baseUrl + '/', token, fetchImpl: async (url, options) => {
    assert.equal(url, baseUrl + '/WeChatAgent/health');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(options.body, undefined);
    return Response.json(payload);
  } });
  assert.deepEqual(await hook.health(), payload);
});

test('Hook health: HTTP error includes route/status', async () => {
  const hook = createHook({ baseUrl, token, fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(hook.health(), /\/WeChatAgent\/health: HTTP 403/);
});

test('Hook health: network error propagates', async () => {
  const hook = createHook({ baseUrl, token, fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(hook.health(), /offline/);
});

test('发送不走 hook 的快捷方法，必须走 sender 的回执闭环', async () => {
  const hook = createHook({ baseUrl, token, fetchImpl: async () => { throw new Error('must not submit here'); } });
  const text = await hook.sendText({});
  assert.equal(text.ok, false);
  assert.match(text.error, /USE_SENDER/);
  const sticker = await hook.sendSticker({});
  assert.equal(sticker.ok, false);
  assert.match(sticker.error, /USE_SENDER/);
  await assert.rejects(hook.receipt(123), /HOOK_RECEIPT_UNSUPPORTED/);
});

test('post 自动带 X-WeChatAgent-Account（取 health 的 databaseAccounts）', async () => {
  const calls = [];
  const hook = createHook({ baseUrl, token, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/WeChatAgent/health')) return Response.json({ databaseAccounts: ['wxid_test'] });
    return Response.json({ ret: 0, retmsg: 'accepted' });
  } });
  const result = await hook.post('/SendTextMsg', { wxidorgid: '123@chatroom', msg: 'hi' });
  assert.deepEqual(result, { ret: 0, retmsg: 'accepted' });
  const submit = calls.at(-1);
  assert.equal(submit.options.method, 'POST');
  assert.equal(submit.options.headers['X-WeChatAgent-Account'], 'wxid_test');
  assert.equal(submit.options.headers['Content-Type'], 'application/json');
  assert.equal(submit.options.body, JSON.stringify({ wxidorgid: '123@chatroom', msg: 'hi' }));
});

test('post 只取一次账号（缓存）', async () => {
  let healthCalls = 0;
  const hook = createHook({ baseUrl, token, fetchImpl: async (url) => {
    if (url.endsWith('/WeChatAgent/health')) { healthCalls += 1; return Response.json({ databaseAccounts: ['wxid_test'] }); }
    return Response.json({ ret: 0 });
  } });
  await hook.post('/SendTextMsg', { wxidorgid: 'a', msg: '1' });
  await hook.post('/SendTextMsg', { wxidorgid: 'a', msg: '2' });
  assert.equal(healthCalls, 1);
});

test('post 在 HTTP 错误时抛出状态与详情', async () => {
  const hook = createHook({
    baseUrl, token, account: 'wxid_x',
    fetchImpl: async () => new Response('{"ret":1,"error":"Version or account mismatch"}', { status: 409 }),
  });
  await assert.rejects(hook.post('/SendTextMsg', {}), /HTTP 409/);
});
