/**
 * transcript.js —— 微信对话记录（2026-10-27）
 *
 * 为什么单独存：
 *   events.jsonl 的 appendEvent 只保留固定字段（id/ts/day/stage/type/source/text…），
 *   我们往里塞的 where / by 会被洗掉 —— 结果 recentTranscript 按聊天过滤永远为空，
 *   她每轮都在"裸聊"，只能靠全局 recall 捞旧片段，于是反复讲同一件事。
 *
 *   所以对话记录放到 ~/.dsh-fish/wechat/transcripts/<聊天>.json，
 *   只用于**给提示词提供上下文**，不进她的记忆、不参与成长判断。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { clockOf, agoOf } from '../clock.js';

export { clockOf, agoOf };

const DEFAULT_MAX_TURNS = 200;
/** 群聊留得更久（2026-10-30）：热群一下午就刷满 200 条，群单独放到 600 */
const GROUP_MAX_TURNS = 600;
const GROUP_KEY = /^wechat:group:/;

/** 这个会话最多留多少轮对话记录 */
export function maxTurnsFor(key) {
  return GROUP_KEY.test(String(key ?? '')) ? GROUP_MAX_TURNS : DEFAULT_MAX_TURNS;
}

function fileOf(root, key) {
  // 用完整 key 的哈希做文件名：字符替换 + 截断会让 a:b 和 a/b 共用一个文件（串聊）
  const safe = createHash('sha256').update(String(key || 'default')).digest('hex').slice(0, 24);
  return path.join(root, 'wechat', 'transcripts', safe + '.json');
}

export function loadTranscript(root, key) {
  const file = fileOf(root, key);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data?.turns) ? data.turns : [];
  } catch {
    return [];
  }
}

export function saveTranscript(root, key, turns) {
  const file = fileOf(root, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, key, turns: turns.slice(-maxTurnsFor(key)), meta: loadMeta(root, key) }, null, 2) + '\n', 'utf8');
}

/** 行为计数与对话保存在同一个文件；旧记录没有 meta 时从零开始。 */
export function loadMeta(root, key) {
  try {
    const data = JSON.parse(readFileSync(fileOf(root, key), 'utf8'));
    return {
      repliesSinceSticker: Math.max(0, Number(data?.meta?.repliesSinceSticker) || 0),
      lastStickerAt: Math.max(0, Number(data?.meta?.lastStickerAt) || 0),
      // 她开口的时刻（回复和表情都算），群聊配额用它算「这一小时说了几句」
      replyAt: Array.isArray(data?.meta?.replyAt)
        ? data.meta.replyAt.map((t) => Number(t)).filter((t) => Number.isFinite(t))
        : [],
    };
  } catch {
    return { repliesSinceSticker: 0, lastStickerAt: 0, replyAt: [] };
  }
}

export function saveMeta(root, key, meta) {
  // 先走既有保存路径，保留 turns 的数量限制与目录创建逻辑。
  saveTranscript(root, key, loadTranscript(root, key));
  const file = fileOf(root, key);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.meta = { ...loadMeta(root, key), ...meta };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 把一批入站消息追加进记录。 */
export function appendIncoming(root, key, rows, now = Date.now()) {
  const turns = loadTranscript(root, key);
  for (const row of rows ?? []) {
    if (!row || row.outgoing === true) continue;
    const text = String(row.text ?? '').trim();
    if (!text) continue;
    turns.push({ self: false, who: String(row.senderName ?? row.sender ?? '群友'), text: text.slice(0, 200), at: now });
  }
  saveTranscript(root, key, turns);
  return turns;
}

/** 把她说的话追加进记录。 */
export function appendReply(root, key, text, now = Date.now()) {
  const body = String(text ?? '').trim();
  if (!body) return;
  const turns = loadTranscript(root, key);
  turns.push({ self: true, who: '你', text: body.slice(0, 200), at: now });
  saveTranscript(root, key, turns);
}

/** 两段话之间超过这个间隔，就认为不是同一段对话了 */
const TALK_GAP_MS = 30 * 60 * 1000;

/**
 * 渲染成提示词段落：群友：… / 你：…
 *
 * 2026-10-30 加时间：以前这里只有「谁说了什么」，没有时间，她就把早上的对话
 * 和下午的当成同一段，下午还在接「早饭吃了没」。现在只要跟上一句隔了半小时以上，
 * 就在前面插一行〔14:05 · 6 小时前〕，她自己能看出来那是另一段。
 */
export function renderTranscript(turns, { limit = 60, maxChars = 5000, now = Date.now(), withTime = true, gapMs = TALK_GAP_MS } = {}) {
  const lines = [];
  let prevAt = 0;
  for (const t of (turns ?? []).slice(-limit)) {
    const text = String(t?.text ?? '').trim();
    if (!text) continue;
    const at = Number(t?.at);
    if (withTime && Number.isFinite(at) && at > 0) {
      if (!prevAt || at - prevAt > gapMs) {
        lines.push(`〔${clockOf(at)} · ${agoOf(at, now)}〕`);
      }
      prevAt = at;
    }
    lines.push((t.self ? '你：' : String(t.who || '群友') + '：') + text);
  }
  let out = lines.filter((line) => line.length > 1).join('\n');
  if ([...out].length > maxChars) out = [...out].slice(-maxChars).join('');
  return out;
}
