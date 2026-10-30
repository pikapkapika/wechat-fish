/**
 * quota.js —— 群聊发言配额（2026-10-30）
 *
 * 为什么单独一个文件：
 *   她在群里原来是一批消息攒够 2 秒就想接一句，热群一天能说上百句，
 *   看着不像在聊天，像在刷屏。私聊是一对一，那个节奏没问题，
 *   所以这道限制**只对群生效**，私聊完全不经过这里。
 *
 * 这是环境参数，不是人格：管的是「一小时最多开口几次」，
 * 不管她说什么、想不想说。配额之内仍然由她自己判断接不接。
 *
 * 被 @ / 拍一拍算点名，直接放行——被人叫到脸上还不吭声不是她。
 *
 * 计数来自 transcript 的 meta.replyAt（回复和表情都算），
 * 不进事件流，也不参与成长判断。
 */

import { loadMeta } from './transcript.js';

export const DEFAULT_PER_HOUR = 4;
export const DEFAULT_GAP_MIN = 10;
export const HOUR_MS = 60 * 60 * 1000;
/** replyAt 只留最近这些条，够覆盖一小时就够了 */
const MAX_REPLY_AT = 200;

/** 非负整数；0 表示不限 */
function whole(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

/**
 * 现在这一批群里能不能开口。
 *
 * @param {object} o
 * @param {string} o.root  她的数据目录
 * @param {string} o.key   会话 key（一个群一份配额）
 * @param {number} [o.now] 测试用时钟
 * @param {number} [o.perHour] 一小时最多几句（0 = 不限）
 * @param {number} [o.gapMin] 两条之间至少隔几分钟（0 = 不限）
 * @returns {{allowed:boolean, reason:string, used:number, cap:number, gapMs:number, nextFreeAt:number}}
 */
export function groupQuota({
  root,
  key,
  now = Date.now(),
  perHour = DEFAULT_PER_HOUR,
  gapMin = DEFAULT_GAP_MIN,
} = {}) {
  const cap = whole(perHour, DEFAULT_PER_HOUR);
  const gapMinutes = whole(gapMin, DEFAULT_GAP_MIN);
  const gapMs = gapMinutes * 60 * 1000;
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  const meta = loadMeta(root, key);
  const replies = Array.isArray(meta.replyAt) ? meta.replyAt : [];
  const recent = replies
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t <= ts && ts - t < HOUR_MS)
    .sort((a, b) => a - b);

  const used = recent.length;
  const last = used ? recent[used - 1] : 0;

  // 先看间隔：刚说完一句，下一句再等一会儿，哪怕配额还有
  if (gapMs > 0 && last > 0 && ts - last < gapMs) {
    return { allowed: false, reason: 'group-gap', used, cap, gapMs, nextFreeAt: last + gapMs };
  }
  // 再看配额：最近一小时已经说满，就等最早那条滑出窗口
  if (cap > 0 && used >= cap) {
    return { allowed: false, reason: 'group-quota', used, cap, gapMs, nextFreeAt: recent[0] + HOUR_MS };
  }
  return { allowed: true, reason: '', used, cap, gapMs, nextFreeAt: 0 };
}

/** 记一次「她开口了」；返回新的 replyAt 数组。 */
export function rememberReply(replyAt, now = Date.now()) {
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const next = (Array.isArray(replyAt) ? replyAt : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t));
  next.push(ts);
  return next.slice(-MAX_REPLY_AT);
}
