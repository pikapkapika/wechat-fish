import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { listLocalMemes, importToOutgoing, pickMeme, fetchRemote } from '../src/memes.js';
import { createBridge } from '../src/index.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-memes-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function image(dir, relative, bytes = Buffer.from('fake-image')) {
  const file = path.join(dir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

test('listLocalMemes identifies first emotion directory and nested images', (t) => {
  const dir = fixture(t);
  const file = image(dir, 'pack/memes/confused/nested/003.webp');
  image(dir, 'pack/memes/happy/no.txt');
  assert.deepEqual(listLocalMemes(dir), [{ file, emotion: 'confused', pack: 'pack' }]);
  assert.deepEqual(listLocalMemes(path.join(dir, 'missing')), []);
});

test('importToOutgoing hashes file and buffer and preserves size/type', (t) => {
  const dir = fixture(t);
  const file = image(dir, 'source.gif');
  const outgoingDir = path.join(dir, 'outgoing');
  const expected = createHash('md5').update(readFileSync(file)).digest('hex');
  const item = importToOutgoing({ file, outgoingDir });
  assert.equal(path.basename(item.path), expected + '.gif');
  assert.ok(existsSync(item.path));
  assert.equal(statSync(item.path).size, item.len);
  assert.equal(item.type, 1);
  const png = importToOutgoing({ buffer: Buffer.from('png'), ext: 'png', outgoingDir });
  assert.equal(png.type, 2);
  assert.throws(() => importToOutgoing({ file, outgoingDir, md5: 'wrong' }), /mismatch/);
  assert.throws(() => importToOutgoing({ buffer: Buffer.alloc(8 * 1024 * 1024 + 1), ext: '.png', outgoingDir }));
  assert.throws(() => importToOutgoing({ buffer: Buffer.from('x'), ext: '../exe', outgoingDir }));
});

test('pickMeme matches emotion and falls back randomly', (t) => {
  const dir = fixture(t);
  image(dir, 'p/memes/happy/a.png');
  image(dir, 'p/memes/sad/b.webp');
  assert.equal(pickMeme({ packsDir: dir, emotion: 'sad', random: () => 0 }).emotion, 'sad');
  assert.ok(pickMeme({ packsDir: dir, emotion: 'unknown', random: () => 0.9 }));
  assert.equal(pickMeme({ packsDir: path.join(dir, 'none') }), null);
});

test('fetchRemote downloads injected bytes, filters emotion and respects limit', async (t) => {
  const cacheDir = fixture(t);
  let calls = 0;
  const bytes = Buffer.from('fake-webp');
  const fetchImpl = async (url) => {
    calls++;
    if (url === 'https://example.test/manifest') return { ok: true, json: async () => ({ items: [
      { path: 'memes/sad/0.webp', url: '/sad.webp' },
      { path: 'memes/happy/1.webp', url: '/1.webp' },
      { path: 'memes/happy/2.webp', url: '/2.webp' },
    ] }) };
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const files = await fetchRemote({ manifestUrl: 'https://example.test/manifest', emotion: 'happy', limit: 1, fetchImpl, cacheDir });
  assert.equal(files.length, 1);
  assert.equal(calls, 2);
  assert.equal(path.dirname(files[0]), cacheDir);
  assert.deepEqual(readFileSync(files[0]), bytes);
});

test('fetchRemote failures never throw', async (t) => {
  const cacheDir = fixture(t);
  for (const fetchImpl of [async () => { throw Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ items: [{ path: 'memes/sad/a.png', url: 'https://example.test/a.png' }] }) })]) {
    assert.deepEqual(await fetchRemote({ manifestUrl: 'https://example.test/list', fetchImpl, cacheDir }), []);
  }
});

test('empty dsh-meme falls back to WeChat pool and preserves send counters', async (t) => {
  const dir = fixture(t);
  const file = image(dir, 'wechat.png');
  let sent;
  const logs = [];
  const bridge = createBridge({
    config: { reader: {}, hook: {}, fish: {}, whitelist: ['wechat:private:123'], stickers: { dir: path.join(dir, 'outgoing') }, memes: { enabled: true, packsDir: path.join(dir, 'empty') } },
    log: (text) => logs.push(text),
    components: { muteFile: null, reader: {}, hook: {}, fish: { turn: async () => ({ kind: 'sticker', emotion: 'happy' }) },
      picker: { pick: () => ({ path: file }) }, pacing: { wait: async () => {} },
      sender: { sendSticker: async (args) => { sent = args; return { ok: true }; } } },
  });
  await bridge._internals.handleBatch({ key: 'wechat:private:123', rows: [] });
  assert.ok(existsSync(sent.sticker.path));
  assert.equal(bridge._internals.status.counters.stickers, 1);
  assert.equal(bridge._internals.status.counters.sent, 1);
  assert.ok(logs.some((text) => text.includes('回落微信')));
});
