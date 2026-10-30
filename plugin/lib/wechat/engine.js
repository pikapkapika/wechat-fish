/** 微信上下文与行为策略；不改变人格，也不把计数写进事件流。 */
import { searchEvents, renderRecall } from '../recall.js';
import { formatBatch } from './format.js';
import { describeMembers, recordReplies } from './members.js';
import { loadTranscript, renderTranscript, appendReply, loadMeta, saveMeta } from './transcript.js';
import { memeBrief } from './memewiki.js';
import { buildPrompt } from './turn.js';
import { rememberReply } from './quota.js';

/** 她自己的话（不是别人说的），可以跨聊天召回；别人的话只在当次聊天里翻。 */
const OWN_WORD_TYPES = new Set(['utterance', 'narration', 'revise']);

function whereLabel(where) {
  const w = String(where ?? '');
  if (/^wechat:group:/.test(w)) return '群里说过';
  if (/^wechat:private:/.test(w)) return '私聊里说过';
  return '说过';
}

export function recallFor(events, batch) {
  try {
    const query = (batch?.rows ?? [])
      .filter((row) => row && row.outgoing !== true && row.text)
      .map((row) => String(row.text)).join(' ').slice(0, 400);
    if (!query.trim()) return '';
    const key = String(batch?.key ?? '');

    // 本聊天：她说的和群友说的都能翻
    const here = searchEvents(events, query, { limit: 6, where: key }).rows;
    const seen = new Set(here.map((row) => row.id).filter(Boolean));

    // 别的聊天：只带她自己说过的话。别人（尤其是私聊里对方）的原话不带——
    // 那是另一个人的话，不该在群里被转述。
    const whereOf = new Map();
    for (const ev of events ?? []) {
      if (ev && ev.id) whereOf.set(String(ev.id), String(ev.where ?? ''));
    }
    const ownElsewhere = searchEvents(events, query, { limit: 30 }).rows
      .filter((row) => OWN_WORD_TYPES.has(row.type) && row.id && !seen.has(String(row.id)))
      // 只在微信的几个会话之间共享；没有归属、也不是微信会话的，不跨过来
      .filter((row) => /^wechat:(?:group|private):/.test(String(whereOf.get(String(row.id)) ?? '')))
      .filter((row) => whereOf.get(String(row.id)) !== key)
      .slice(0, 3);

    if (!here.length && !ownElsewhere.length) return '';
    const parts = [];
    if (here.length) parts.push(renderRecall(here));
    if (ownElsewhere.length) {
      parts.push('〔你在别的地方说过的话〕\n' + ownElsewhere
        .map((row) => `- ${row.date}｜（${whereLabel(whereOf.get(String(row.id)))}）${row.text}${row.id ? `（${row.id}）` : ''}`)
        .join('\n'));
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** 群聊的上下文窗口（2026-10-30）：从最近 60 条 / 5000 字放宽到 120 条 / 8000 字。 */
const GROUP_HISTORY = { limit: 120, maxChars: 8000 };

function historyWindowFor(key) {
  return /^wechat:group:/.test(String(key ?? '')) ? GROUP_HISTORY : {};
}

export function buildContext({ root, batch = {}, identity = '', self = null, events = [], now = Date.now() }) {
  const history = renderTranscript(loadTranscript(root, batch.key), { ...historyWindowFor(batch.key), now });
  const members = describeMembers(root, batch);
  const recall = recallFor(events, batch);
  const meme = memeBrief(root, batch.rows ?? []);
  return { prompt: buildPrompt({ identity, self, recall, members, history, meme, batchText: formatBatch(batch).text, now }), history, members, meme, batch };
}

function signatureOf(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\p{P}\s]/gu, '');
}

/** 两个短句的相似度（最长公共子串 / 较短者长度），用来挡"换汤不换药"的复读。 */
function similarity(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (!x || !y) return 0;
  // 短句（骂人话常常只有两三个字）用包含判断，长句再用公共子串
  if (x.length < 4 || y.length < 4) return x.includes(y) || y.includes(x) ? 1 : 0;
  const m = x.length;
  const n = y.length;
  let best = 0;
  const prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    let diag = 0;
    for (let j = 1; j <= n; j += 1) {
      const tmp = prev[j];
      if (x[i - 1] === y[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else {
        prev[j] = 0;
      }
      diag = tmp;
    }
  }
  return best / Math.min(m, n);
}

export function checkRepeat({ root, batch, text }) {
  const signature = signatureOf(text);
  const recent = loadTranscript(root, batch?.key).filter((turn) => turn.self === true).slice(-20);
  // 完全一样算重复；换了几个字但骨架相同（追着骂时特别容易）也算重复。
  const duplicated = !!signature && recent.some((turn) => {
    const other = signatureOf(turn.text);
    if (!other) return false;
    if (other === signature) return true;
    return similarity(other, signature) >= 0.75;
  });
  return { duplicated, signature };
}

/** 在即将回复之前判断，因此第 N 次看的是已有次数 + 1。 */
export function stickerDue({ root, batch, config = {} }) {
  const stickers = config?.stickers ?? {};
  const meta = loadMeta(root, batch?.key);
  const cooldown = Math.max(0, Number(stickers.cooldownMs) || 0);
  if (meta.lastStickerAt && Date.now() - meta.lastStickerAt < cooldown) return false;
  const every = Math.floor(Number(stickers.autoEvery) || 0);
  if (every > 0 && meta.repliesSinceSticker + 1 >= every) return true;
  const chance = Math.max(0, Math.min(1, Number(stickers.autoChance) || 0));
  return chance > 0 && Math.random() < chance;
}

export function markReplied({ root, batch, text, now = Date.now() }) {
  recordReplies(root, batch?.key, batch?.rows ?? []);
  appendReply(root, batch?.key, text, now);
  const meta = loadMeta(root, batch?.key);
  saveMeta(root, batch?.key, {
    ...meta,
    repliesSinceSticker: meta.repliesSinceSticker + 1,
    replyAt: rememberReply(meta.replyAt, now),
  });
}

export function markSticker({ root, batch, now = Date.now() }) {
  const meta = loadMeta(root, batch?.key);
  saveMeta(root, batch?.key, {
    ...meta,
    repliesSinceSticker: 0,
    lastStickerAt: now,
    replyAt: rememberReply(meta.replyAt, now),
  });
}


/**
 * 话题刹车：她最近 3 句回复里有共同的片段，且这一批消息又提到它，
 * 就判定为"同一个话题原地打转"，直接闭嘴一次。
 * 只做字面判断，不懂语义——宁可少说一句，也不要绕圈。
 */
export function topicLoop({ root, batch, window = 3, minLen = 2 }) {
  const turns = loadTranscript(root, batch?.key).filter((x) => x.self).slice(-window);
  if (turns.length < window) return false;
  const texts = turns.map((x) => String(x.text ?? '').trim()).filter(Boolean);
  if (texts.length < window) return false;

  // 找三句的共同子串（长度 >= minLen）
  const common = (a, b) => {
    let best = '';
    for (let i = 0; i < a.length; i += 1) {
      for (let len = minLen; i + len <= a.length; len += 1) {
        const piece = a.slice(i, i + len);
        if (b.includes(piece) && piece.length > best.length) best = piece;
      }
    }
    return best;
  };
  let shared = texts[0];
  for (const other of texts.slice(1)) {
    shared = common(shared, other);
    if (shared.length < minLen) return false;
  }
  const body = (batch?.rows ?? []).map((row) => String(row.text ?? '')).join(' ');
  return body.includes(shared);
}
