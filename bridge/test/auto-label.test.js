import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutoLabeler, listCandidates } from '../src/auto-label.js';

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'fish-autolabel-'));
  const outgoing = path.join(root, 'outgoing');
  const packs = path.join(root, 'packs');
  mkdirSync(outgoing, { recursive: true });
  mkdirSync(packs, { recursive: true });
  if (files) {
    for (const name of files) writeFileSync(path.join(outgoing, name), 'x');
  }
  return { root, outgoing, packs, labels: path.join(root, 'labels.json') };
}

test('列出待打标文件：池子与图库都扫', () => {
  const f = fixture(['a.gif', 'b.webp']);
  try {
    const list = listCandidates({ outgoingDir: f.outgoing, packsDir: f.packs });
    assert.equal(list.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('只补没有标签的，并写入文件', async () => {
  const f = fixture(['a.gif', 'b.gif']);
  try {
    writeFileSync(f.labels, JSON.stringify({ items: { [path.join(f.outgoing, 'a.gif')]: { caption: '已有', tags: ['旧'], emotion: 'happy' } } }));
    const calls = [];
    const labeler = createAutoLabeler({
      baseUrl: 'http://127.0.0.1:1', token: 't', outgoingDir: f.outgoing, packsDir: f.packs, labelsFile: f.labels,
      fetchImpl: async (url, init) => {
        calls.push(JSON.parse(init.body).path);
        return { ok: true, json: async () => ({ ok: true, caption: '猫', tags: ['猫'], emotion: 'happy' }) };
      },
      log: () => {},
    });
    const result = await labeler.runOnce();
    assert.equal(result.labelled, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('b.gif'), '不该重复打已有标签的图');
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('有回复在途时跳过这一轮', async () => {
  const f = fixture(['a.gif']);
  try {
    let called = 0;
    const labeler = createAutoLabeler({
      baseUrl: 'http://127.0.0.1:1', token: 't', outgoingDir: f.outgoing, packsDir: f.packs, labelsFile: f.labels,
      fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ ok: true }) }; },
      isBusy: () => true,
      log: () => {},
    });
    const result = await labeler.runOnce();
    assert.equal(result.skipped, 'busy');
    assert.equal(called, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('模型不支持图片时停用', async () => {
  const f = fixture(['a.gif']);
  try {
    const labeler = createAutoLabeler({
      baseUrl: 'http://127.0.0.1:1', token: 't', outgoingDir: f.outgoing, packsDir: f.packs, labelsFile: f.labels,
      fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'MODEL_IMAGE_INPUT_UNSUPPORTED' }) }),
      log: () => {},
    });
    await labeler.runOnce();
    assert.equal(labeler.disabled, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('每轮限量', async () => {
  const names = Array.from({ length: 10 }, (_, i) => 'x' + i + '.gif');
  const f = fixture(names);
  try {
    let called = 0;
    const labeler = createAutoLabeler({
      baseUrl: 'http://127.0.0.1:1', token: 't', outgoingDir: f.outgoing, packsDir: f.packs, labelsFile: f.labels, batch: 3,
      fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ ok: true, caption: '猫', tags: ['猫'], emotion: 'happy' }) }; },
      log: () => {},
    });
    const result = await labeler.runOnce();
    assert.equal(result.labelled, 3);
    assert.equal(called, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 5 });
  }
});
