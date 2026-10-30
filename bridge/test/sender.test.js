import test from 'node:test';
import assert from 'node:assert/strict';
import { createSender } from '../src/sender.js';

function fixture({ sessions = [{ username: 'room@chatroom', displayName: 'Room', conversationId: 42 }],
  batches = [[], []], ret = 0, failure } = {}) {
  let time = 0;
  let index = 0;
  const calls = [];
  const sender = createSender({
    reader: {
      async sessions() { calls.push(['sessions']); return { sessions }; },
      async messages(wxid) {
        calls.push(['messages', wxid]);
        if (failure) throw new Error(failure);
        return { messages: batches[Math.min(index++, batches.length - 1)] };
      },
    },
    hook: { async post(route, body) { calls.push(['post', route, body]); return { ret }; } },
    conversationId(username, name, mapped) {
      calls.push(['conversationId', username, name, mapped]);
      return mapped;
    },
    pollMs: 4, receiptTimeoutMs: 10, now: () => time,
    sleep: async ms => { calls.push(['sleep', ms]); time += ms; },
  });
  return { sender, calls, time: () => time };
}
const input = { kind: 'group', target: '42', text: ' hello ' };
const receipt = (extra = {}) => ({ localId: 2, isSend: true, localType: 1, fullText: 'hello', serverId: '123', ...extra });

test('baseline → native submit → new matching confirmed receipt', async () => {
  const f = fixture({ batches: [[receipt({ localId: '1' })],
    [receipt({ localId: 1 }), receipt({ isSend: false }), receipt({ serverId: 0 }), receipt({ localType: 47 })],
    [receipt({ localType: undefined, fullText: undefined, parsedContent: ' hello ' })]] });
  assert.deepEqual(await f.sender.sendText(input), { ok: true, messageId: 2 });
  assert.deepEqual(f.calls.filter(c => c[0] !== 'conversationId'), [
    ['sessions'], ['messages', 'room@chatroom'],
    ['post', '/SendTextMsg', { wxidorgid: 'room@chatroom', msg: ' hello ' }],
    ['messages', 'room@chatroom'], ['sleep', 4], ['messages', 'room@chatroom'],
  ]);
});

test('ret !== 0 rejects without polling', async () => {
  const f = fixture({ ret: 1 });
  assert.deepEqual(await f.sender.sendText(input), { ok: false, error: 'NATIVE_SEND_REJECTED' });
  assert.equal(f.calls.filter(c => c[0] === 'messages').length, 1);
});

test('receipt timeout advances only injected clock', async () => {
  const f = fixture();
  assert.deepEqual(await f.sender.sendText(input), { ok: false, error: 'TEXT_DELIVERY_UNCONFIRMED' });
  assert.equal(f.time(), 10);
  assert.deepEqual(f.calls.filter(c => c[0] === 'sleep'), [['sleep', 4], ['sleep', 4], ['sleep', 2]]);
});

for (const sessions of [[], [
  { username: 'a@chatroom', conversationId: 42 }, { username: 'b@chatroom', conversationId: 42 },
]]) {
  test(`target needs exactly one mapping (${sessions.length} found)`, async () => {
    const f = fixture({ sessions });
    assert.deepEqual(await f.sender.sendText(input), { ok: false, error: 'TARGET_MAPPING_AMBIGUOUS_OR_MISSING' });
    assert.equal(f.calls.some(c => ['post', 'messages'].includes(c[0])), false);
  });
}

test('kind prevents matching private session as group', async () => {
  const f = fixture({ sessions: [{ username: 'wxid_friend', conversationId: 42 }] });
  assert.equal((await f.sender.sendText(input)).ok, false);
  assert.deepEqual(await f.sender.sendText({ ...input, kind: 'private' }), { ok: false, error: 'TEXT_DELIVERY_UNCONFIRMED' });
});

test('reader failure returns failure rather than throwing', async () => {
  const f = fixture({ failure: 'READER_DOWN' });
  assert.deepEqual(await f.sender.sendText(input), { ok: false, error: 'READER_DOWN' });
  assert.equal(f.calls.some(c => c[0] === 'post'), false);
});

test('sticker 按原生字段提交并确认回执', async () => {
  const f = fixture({ batches: [[], [receipt({ localType: 47, fullText: '<emoji/>' })]] });
  const sticker = { md5: 'a'.repeat(32), path: 'C:/outgoing/' + 'a'.repeat(32) + '.gif', len: 1024, type: 1 };
  assert.deepEqual(await f.sender.sendSticker({ kind: 'group', target: 42, sticker }),
    { ok: true, messageId: 2 });
  const post = f.calls.find(c => c[0] === 'post');
  assert.equal(post[1], '/SendStickerMsg');
  assert.equal(post[2].wxidorgid, 'room@chatroom');
  assert.equal(post[2].sticker.md5, sticker.md5);
  // 白名单复制失败时退回原路径，但文件名仍以 md5 命名
  assert.ok(String(post[2].path).endsWith(sticker.md5 + '.gif'));
});

test('invalid arguments are the only throwing failures', () => {
  const f = fixture();
  assert.throws(() => f.sender.sendText({ ...input, text: '' }), /INVALID_TEXT/);
  assert.throws(() => f.sender.sendText({ ...input, kind: 'other' }), /INVALID_TARGET/);
  assert.throws(() => f.sender.sendSticker({ kind: 'group', target: 42 }), /INVALID_STICKER/);
  assert.throws(() => createSender(), /INVALID_SENDER_OPTIONS/);
});
