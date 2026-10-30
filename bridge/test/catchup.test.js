// 重连/启动补偿：断线期间漏掉的消息要能补回来
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../src/index.js';

function fakeHttp() {
  const server = {
    close(cb) { if (cb) cb(); },
    closeIdleConnections() {},
    once() {},
    listen(port, host, cb) { if (cb) cb(); return this; },
    on() { return this; },
  };
  return { createServer() { return server; } };
}

function fixture(messages) {
  const turns = [];
  const components = {
    http: fakeHttp(),
    reader: {
      async sessions() {
        return { sessions: [{ username: '1@chatroom', conversationId: '1', displayName: '测试群' }] };
      },
      async messages() {
        return { messages };
      },
      async status() { return { success: true }; },
      push() { return new Promise(() => {}); }, // 永不返回，模拟"正在等 SSE"
    },
    hook: { async post() { return { ret: 0 }; } },
    sender: {
      async sendText() { return { ok: true, messageId: 1 }; },
      async sendSticker() { return { ok: true, messageId: 2 }; },
    },
    fish: {
      async turn(batch) { turns.push(batch); return { kind: 'silent', text: '' }; },
    },
    picker: { count: () => 0, pick: () => null },
    dedupe: { seen: () => false, remember: () => {} },
    pacing: { wait: async () => {} },
    batcher: { push: () => ({ flush: false }), flushNow: () => null, tick: () => null },
  };
  return { components, turns };
}

test('启动时把断线期间漏掉的消息补进来', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const { components, turns } = fixture([
    { localId: 1, serverId: 11, createTime: nowSec - 30, isSend: 0, parsedContent: '漏掉的一句', senderDisplay: 'A', senderUsername: 'a' },
    { localId: 2, serverId: 12, createTime: nowSec - 10, isSend: 1, parsedContent: '她自己说的', senderDisplay: '她', senderUsername: 'me' },
  ]);
  const bridge = createBridge({
    config: {
      reader: { baseUrl: 'http://127.0.0.1:1', token: 't' },
      hook: { baseUrl: 'http://127.0.0.1:2', token: 't' },
      fish: { baseUrl: 'http://127.0.0.1:3', token: 't' },
      whitelist: ['wechat:group:1'],
      ownWxid: '',
    },
    components,
    log: () => {},
  });
  bridge.start();
  await new Promise((r) => setTimeout(r, 120));
  await bridge.stop();

  const texts = turns.flatMap((b) => (b.rows ?? []).map((r) => r.text));
  assert.ok(texts.includes('漏掉的一句'), '补回来的应该包含漏掉的那句');
  assert.ok(!texts.includes('她自己说的'), '自己发的不能补进来');
});

test('太旧的消息不补（启动只回看 2 分钟）', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const { components, turns } = fixture([
    { localId: 9, serverId: 99, createTime: nowSec - 600, isSend: 0, parsedContent: '十分钟前的旧话', senderDisplay: 'A', senderUsername: 'a' },
  ]);
  const bridge = createBridge({
    config: {
      reader: { baseUrl: 'http://127.0.0.1:1', token: 't' },
      hook: { baseUrl: 'http://127.0.0.1:2', token: 't' },
      fish: { baseUrl: 'http://127.0.0.1:3', token: 't' },
      whitelist: ['wechat:group:1'],
      ownWxid: '',
    },
    components,
    log: () => {},
  });
  bridge.start();
  await new Promise((r) => setTimeout(r, 120));
  await bridge.stop();
  assert.equal(turns.length, 0, '旧消息不该被补进来');
});
