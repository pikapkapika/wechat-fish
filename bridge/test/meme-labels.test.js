import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLabels, weekdayMismatch, pickByLabel } from '../src/meme-labels.js';

const at = (labels) => new Map(Object.entries(labels));

test('星期对不上就跳过', () => {
  assert.equal(weekdayMismatch({ caption: '敲鼓庆祝周五', tags: ['周五'] }, 3), true);
  assert.equal(weekdayMismatch({ caption: '敲鼓庆祝周五', tags: ['周五'] }, 5), false);
  assert.equal(weekdayMismatch({ caption: '蓝发女仆举剑', tags: ['女仆'] }, 3), false);
  assert.equal(weekdayMismatch(null, 3), false);
});

test('周三不会抽到"周五"那张', () => {
  const candidates = [
    { file: 'C:/a/zhouwu.webp', emotion: 'happy' },
    { file: 'C:/a/plain.webp', emotion: 'happy' },
  ];
  const labels = at({
    'zhouwu.webp': { caption: '敲鼓庆祝周五', tags: ['周五'], emotion: 'happy' },
    'plain.webp': { caption: '蓝发女仆笑', tags: ['女仆'], emotion: 'happy' },
  });
  for (let i = 0; i < 30; i += 1) {
    assert.equal(pickByLabel(candidates, labels, 'happy', { today: 3 }).file, 'C:/a/plain.webp');
  }
});

test('情绪匹配优先', () => {
  const candidates = [
    { file: 'C:/a/happy.webp' },
    { file: 'C:/a/angry.webp' },
  ];
  const labels = at({
    'happy.webp': { caption: '笑', tags: ['开心'], emotion: 'happy' },
    'angry.webp': { caption: '骂', tags: ['生气'], emotion: 'angry' },
  });
  assert.equal(pickByLabel(candidates, labels, 'angry').file, 'C:/a/angry.webp');
  assert.equal(pickByLabel(candidates, labels, 'happy').file, 'C:/a/happy.webp');
});

test('没有标签也能选（不崩）', () => {
  const candidates = [{ file: 'C:/a/x.webp' }];
  const picked = pickByLabel(candidates, new Map(), 'happy');
  assert.equal(picked.file, 'C:/a/x.webp');
  assert.equal(pickByLabel([], new Map(), 'happy'), null);
});

test('loadLabels 读真实文件并缓存', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fish-labels-'));
  try {
    const file = path.join(dir, 'sticker-labels.json');
    writeFileSync(file, JSON.stringify({ items: { 'abc.png': { caption: '猫', tags: ['猫'], emotion: 'happy' } } }), 'utf8');
    const map = loadLabels(file);
    assert.equal(map.get('abc.png').emotion, 'happy');
    assert.equal(loadLabels(file), map, '第二次应命中缓存');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
