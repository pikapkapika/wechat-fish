import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, createBridge } from '../src/index.js';

function fixture({ results = [], sends = [], events = [], statusPort, picker = { pick() { return { md5: '12345678' }; } } } = {}) {
  let handler;
  const calls = [];
  const server = {
    on() {}, listen(...args) { this.address = args; },
    close(done) { this.closed = true; done(); },
  };
  const bridge = createBridge({
    config: { whitelist: ['wechat:private:1'], statusPort }, log() {},
    components: {
      http: { createServer(fn) { handler = fn; return server; } },
      reader: { push() {
        const event = events.shift();
        if (event instanceof Error) return Promise.reject(event);
        return event ? Promise.resolve(event) : new Promise(() => {});
      } },
      hook: { async health() { return {}; }, async account() { return 'wxid_test'; } },
      sender: {
        async sendText(args) { calls.push(['text', args]); return sends.shift() ?? { ok: true }; },
        async sendSticker(args) { calls.push(['sticker', args]); return sends.shift() ?? { ok: true }; },
      },
      fish: { async turn() { return results.shift(); } },
      picker,
      pacing: { async wait(kind) { calls.push(['wait', kind]); } },
      batcher: { push() {}, tick() {}, flushNow() {} },
      dedupe: { seen() { return false; }, remember() {} },
    },
  });
  return { bridge, server, calls, request(method = 'GET', url = '/status') {
    const res = { writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
    handler({ method, url }, res);
    return res;
  } };
}
const batch = { key: 'wechat:private:1' };

test('buildStatus has exact initial fields and independent state', () => {
  assert.deepEqual(buildStatus(123), {
    ok: true, startedAt: 123,
    reader: { connected: false, lastEventAt: 0, reconnects: 0 },
    fish: { connected: false, lastReplyAt: 0, lastError: '' },
    hook: { ok: false, account: '' },
    counters: { events: 0, replies: 0, silents: 0, sent: 0, failed: 0, stickers: 0 },
  });
  const first = buildStatus(); first.counters.events++;
  assert.equal(buildStatus().counters.events, 0);
});

test('reply, silent, sends and stickers increment counters and record error codes', async () => {
  const { bridge } = fixture({
    results: [{ kind: 'reply', text: 'one' }, { kind: 'reply', text: 'two' }, { kind: 'silent' }, { kind: 'sticker' }],
    sends: [{ ok: true }, { ok: false, error: 'RECEIPT_TIMEOUT' }, { ok: true }],
  });
  for (let i = 0; i < 4; i++) await bridge._internals.handleBatch(batch);
  const s = bridge._internals.status;
  assert.deepEqual(s.counters, { events: 0, replies: 2, silents: 1, sent: 2, failed: 1, stickers: 1 });
  assert.equal(s.fish.connected, true);
  assert.ok(s.fish.lastReplyAt > 0);
  assert.equal(s.fish.lastError, 'RECEIPT_TIMEOUT');
});

test('repeated engine replies are sent unchanged, paced each time, without extra stickers', async () => {
  const texts = ['同一句！', '同一句！', '同一句', '  同一句  '];
  const { bridge, calls } = fixture({
    results: texts.map(text => ({ kind: 'reply', text })),
    picker: { pick() { assert.fail('reply must not pick a sticker'); } },
  });
  for (const text of texts) await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls, texts.flatMap(text => [
    ['wait', 'reply'], ['text', { kind: 'private', target: '1', text }],
  ]));
  assert.equal(bridge._internals.status.counters.sent, texts.length);
  assert.equal(bridge._internals.status.counters.stickers, 0);
});

test('sticker commands send only the selected sticker and wait before each send', async () => {
  const sticker = { md5: 'abcdef12' };
  let picks = 0;
  const { bridge, calls } = fixture({
    results: [{ kind: 'sticker', text: 'not a text command' }, { kind: 'sticker' }],
    picker: { pick() { picks++; return sticker; } },
    sends: [{ ok: true }, { ok: false, error: 'STICKER_FAILED' }],
  });
  await bridge._internals.handleBatch(batch);
  await bridge._internals.handleBatch(batch);
  assert.equal(picks, 2);
  assert.deepEqual(calls, [
    ['wait', 'sticker'], ['sticker', { kind: 'private', target: '1', sticker }],
    ['wait', 'sticker'], ['sticker', { kind: 'private', target: '1', sticker }],
  ]);
  assert.deepEqual(bridge._internals.status.counters,
    { events: 0, replies: 0, silents: 0, sent: 1, failed: 1, stickers: 1 });
  assert.equal(bridge._internals.status.fish.lastError, 'STICKER_FAILED');
});

test('reply marker lines send accompanying text then one sticker, awaiting each receipt', async () => {
  for (const marker of ['[表情]', '［表情］', '【表情】']) {
    const { bridge, calls } = fixture({ results: [{ kind: 'reply', text: `第一行\r\n  ${marker}  \r\n第二行` }] });
    await bridge._internals.handleBatch(batch);
    assert.deepEqual(calls, [
      ['wait', 'reply'], ['text', { kind: 'private', target: '1', text: '第一行\n第二行' }],
      ['wait', 'sticker'], ['sticker', { kind: 'private', target: '1', sticker: { md5: '12345678' } }],
    ]);
  }
});

test('marker-only reply sends only one sticker', async () => {
  const { bridge, calls } = fixture({ results: [{ kind: 'reply', text: ' \n [表情] \n ' }] });
  await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls.map(call => call[0]), ['wait', 'sticker']);
});

test('inline markers remain ordinary text and sticker kind does not send twice', async () => {
  const { bridge, calls } = fixture({ results: [
    { kind: 'reply', text: '这是[表情]说明' }, { kind: 'sticker', text: '[表情]\n不应发文字' },
  ] });
  await bridge._internals.handleBatch(batch);
  await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls.map(call => call[0]), ['wait', 'text', 'wait', 'sticker']);
  assert.equal(calls[1][1].text, '这是[表情]说明');
});

test('rejected marker sticker never falls back to marker text', async () => {
  const { bridge, calls } = fixture({
    results: [{ kind: 'reply', text: '[表情]\n伴随文字' }],
    sends: [{ ok: true }, { ok: false, error: 'NATIVE_SEND_REJECTED' }],
  });
  await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls.filter(call => call[0] === 'text').map(call => call[1].text), ['伴随文字']);
  assert.equal(bridge._internals.status.counters.failed, 1);
  assert.equal(bridge._internals.status.fish.lastError, 'NATIVE_SEND_REJECTED');
});

test('silent commands do not pick, pace or send even when text is present', async () => {
  const { bridge, calls } = fixture({
    results: [{ kind: 'silent', text: 'do not send' }],
    picker: { pick() { assert.fail('silent must not pick a sticker'); } },
  });
  await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls, []);
  assert.deepEqual(bridge._internals.status.counters,
    { events: 0, replies: 0, silents: 1, sent: 0, failed: 0, stickers: 0 });
});

test('empty sticker pool skips I/O without claiming a successful send', async () => {
  const { bridge, calls } = fixture({ results: [{ kind: 'sticker' }], picker: { pick() { return null; } } });
  await bridge._internals.handleBatch(batch);
  assert.deepEqual(calls, []);
  assert.deepEqual(bridge._internals.status.counters,
    { events: 0, replies: 0, silents: 0, sent: 0, failed: 0, stickers: 0 });
});

test('injected HTTP serves status on loopback and closes on stop', async () => {
  const f = fixture({ events: [{ event: 'ignored' }], statusPort: 12345 });
  try {
    f.bridge.start();
    await new Promise(setImmediate);
    assert.deepEqual(f.server.address, [12345, '127.0.0.1']);
    const res = f.request();
    assert.equal(res.code, 200);
    const s = JSON.parse(res.body);
    assert.equal(s.reader.connected, true);
    assert.equal(s.counters.events, 1);
    assert.ok(s.reader.lastEventAt > 0);
    assert.deepEqual(s.hook, { ok: true, account: 'wxid_test' });
    assert.equal(f.request('POST').code, 404);
    assert.equal(f.request('GET', '/other').code, 404);
  } finally { await f.bridge.stop(); }
  assert.equal(f.server.closed, true);
});

test('reader errors mark disconnected and increment reconnect count; stop cancels retry', async () => {
  const f = fixture({ events: [new Error('offline')] });
  try {
    f.bridge.start();
    await new Promise(setImmediate);
    assert.deepEqual(f.server.address, [11232, '127.0.0.1']);
    assert.equal(f.bridge._internals.status.reader.connected, false);
    assert.equal(f.bridge._internals.status.reader.reconnects, 1);
  } finally { await f.bridge.stop(); }
});
