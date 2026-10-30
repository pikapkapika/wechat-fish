/**
 * 限流器（第 2 件不能省的事：随机间隔 + 每分钟上限，防封号）。
 *
 * 契约：
 *   createPacing({ baseMs = 10000, jitter = [0.6, 3.0], maxPerMinute = 10,
 *                  random = Math.random }) →
 *     { delayMs(), wait(kind) → Promise<void>, recentCount() }
 *
 * 另外允许注入 { now, sleep }（契约里明确允许，默认 Date.now / setTimeout），
 * 测试可换成假时钟 + 假 sleep，整套用例毫秒级跑完。
 *
 * 时序（严格按契约）：
 *   wait() 先睡 delayMs()，睡醒后看「最近 60s 内已发送条数」；
 *   达到 maxPerMinute 就睡到最早那条滑出窗口，再复查，直到有名额为止，
 *   最后记下本次发送时刻。
 *
 * kind 只用于调用方日志定位，不参与任何时长计算。
 */

const DEFAULT_BASE_MS = 10000;
const DEFAULT_JITTER = [0.6, 3.0];
const DEFAULT_MAX_PER_MINUTE = 10;
const MIN_DELAY_MS = 800;
const WINDOW_MS = 60000;
/** 防御性上限：正常情况下配额循环最多一轮，这里只防坏时钟造成死循环 */
const MAX_QUOTA_ROUNDS = 1000;

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function createPacing({
  baseMs = DEFAULT_BASE_MS,
  jitter = DEFAULT_JITTER,
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
  random = Math.random,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const base = Math.max(0, finiteNumber(baseMs, DEFAULT_BASE_MS));

  const range = Array.isArray(jitter) ? jitter : DEFAULT_JITTER;
  const lo = finiteNumber(range[0], DEFAULT_JITTER[0]);
  const hi = finiteNumber(range[1], DEFAULT_JITTER[1]);

  // 配额为 0 会让 wait() 永远无法返回，这里兜到 1。
  const cap = Math.max(1, Math.floor(finiteNumber(maxPerMinute, DEFAULT_MAX_PER_MINUTE)));

  const nextRandom = typeof random === 'function' ? random : Math.random;
  const clock = typeof now === 'function' ? now : Date.now;
  const waitFor = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 已发送时刻，升序 */
  const sentAt = [];

  function currentTime() {
    const t = clock();
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
  }

  /** 丢掉已经滑出 60s 窗口的时间戳 */
  function prune(ts) {
    while (sentAt.length > 0 && ts - sentAt[0] >= WINDOW_MS) sentAt.shift();
  }

  /**
   * round(baseMs * (lo + random() * (hi - lo)))，下限 800ms。
   * random 返回非有限值时按 0 处理（等价于取下限），不返回 NaN。
   */
  function delayMs() {
    const unit = Number(nextRandom());
    const r = Number.isFinite(unit) ? unit : 0;
    const scaled = base * (lo + r * (hi - lo));
    if (!Number.isFinite(scaled)) return MIN_DELAY_MS;
    return Math.max(MIN_DELAY_MS, Math.round(scaled));
  }

  /** 记录发送时刻；时钟回拨时保持升序，prune() 才能只扫队头 */
  function record(ts) {
    sentAt.push(ts);
    if (sentAt.length > 1 && sentAt[sentAt.length - 2] > ts) {
      sentAt.sort((a, b) => a - b);
    }
  }

  /** 先随机延迟，再等配额；kind 不影响时长 */
  async function wait(kind) {
    await waitFor(delayMs());

    prune(currentTime());

    let rounds = 0;
    while (sentAt.length >= cap && rounds < MAX_QUOTA_ROUNDS) {
      const ts = currentTime();
      const freeAt = sentAt[0] + WINDOW_MS;
      const remaining = Math.ceil(freeAt - ts);
      // remaining 应恒 > 0；兜底至少推进 1ms，避免假时钟不前进时空转
      await waitFor(remaining > 0 ? remaining : 1);
      prune(currentTime());
      rounds += 1;
    }

    record(currentTime());
  }

  /** 最近 60s 内已发送条数 */
  function recentCount() {
    prune(currentTime());
    return sentAt.length;
  }

  return { delayMs, wait, recentCount };
}
