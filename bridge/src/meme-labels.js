// 按标签挑表情：优先情绪匹配，跳过"星期几"对不上的图
//
// 标签来自 ~/.dsh-fish/wechat/sticker-labels.json（由 label-stickers.mjs 生成，
// 每张图有 caption / tags / emotion）。没有标签的图仍然可以选，只是排序靠后。

import fs from 'node:fs';
import path from 'node:path';

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

let cache = { at: 0, file: '', map: new Map() };

export function loadLabels(file) {
  const now = Date.now();
  if (cache.file === file && now - cache.at < 60_000) return cache.map;
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(data?.items ?? {})) {
      map.set(path.basename(key), { file: key, ...value });
    }
  } catch {
    /* 没有标签文件就用空 map */
  }
  cache = { at: now, file, map };
  return map;
}

/** 图里带"周三"之类字样、但今天不是那天 → 跳过。 */
export function weekdayMismatch(label, today = new Date().getDay() || 7) {
  const text = String(label?.caption ?? '') + ' ' + (label?.tags ?? []).join(' ');
  const hit = /(?:周|星期)([一二三四五六日天])/.exec(text);
  if (!hit) return false;
  const day = WEEKDAY[hit[1]];
  return Boolean(day) && day !== today;
}

function score(label, emotion) {
  if (!label) return 0;
  let value = 0;
  if (emotion && label.emotion === emotion) value += 5;
  if (emotion && (label.tags ?? []).some((tag) => String(tag).includes(emotion))) value += 2;
  return value;
}

/**
 * 从候选里挑一张：跳过星期对不上的，优先情绪匹配；全都一样就随机。
 * @param {Array<{file:string}>} candidates
 * @param {Map<string, object>} labels
 */
export function pickByLabel(candidates, labels, emotion, { random = Math.random, today = new Date().getDay() || 7 } = {}) {
  if (!candidates.length) return null;
  const usable = candidates.filter((item) => !weekdayMismatch(labels.get(path.basename(item.file)), today));
  const pool = usable.length ? usable : candidates;
  let best = -1;
  let bestPool = [];
  for (const item of pool) {
    const value = score(labels.get(path.basename(item.file)), emotion);
    if (value > best) { best = value; bestPool = [item]; }
    else if (value === best) bestPool.push(item);
  }
  return bestPool[Math.floor(random() * bestPool.length) % bestPool.length];
}
