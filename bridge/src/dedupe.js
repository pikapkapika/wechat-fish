/**
 * 去重器（第 1 件不能省的事：按消息 id 防重复注入）。
 *
 * 契约：
 *   createDedupe({ ttlMs = 600000, max = 5000 }) →
 *     { seen(id) → boolean, remember(id), size() }
 *
 * 实现要点：
 * - Map 的迭代顺序就是插入顺序；ttl 固定时「插入顺序 === 过期顺序」，
 *   因此过期清理只需从队头扫描，命中就删，遇到未过期即停。
 * - 容量上限用同一个队头淘汰：删最旧的。
 * - 额外支持注入 now（默认 Date.now），便于测试用假时钟推进 TTL；
 *   契约里 ttlMs / max 的名称、顺序、默认值保持不变。
 * - id 必须是字符串；空字符串或非字符串一律视为「不可去重的 id」：
 *   seen() 返回 false，remember() 静默忽略，绝不抛异常拖垮主循环。
 */

const DEFAULT_TTL_MS = 600000;
const DEFAULT_MAX = 5000;

/** 只接受有限数字，其余回退默认值 */
function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 合法 id 原样返回；非法 id 返回 null（调用方据此短路） */
function normalizeId(id) {
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function createDedupe({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
  const ttl = finiteNumber(ttlMs, DEFAULT_TTL_MS);
  // 容量允许为 0（此时什么都不记），负数按 0 处理；非数字回退默认值。
  const capacity = Math.max(0, Math.floor(finiteNumber(max, DEFAULT_MAX)));
  const clock = typeof now === 'function' ? now : Date.now;

  /** id → 过期时刻（毫秒时间戳），按插入顺序排列 */
  const entries = new Map();

  /** 读时钟；坏时钟不至于让整个去重器崩掉 */
  function currentTime() {
    const t = clock();
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
  }

  /** 从队头清掉所有已过期条目（过期顺序 === 插入顺序） */
  function prune(ts) {
    for (const [id, expiresAt] of entries) {
      if (expiresAt <= ts) entries.delete(id);
      else break;
    }
  }

  /** 是否已记住且未过期。查询不会续期。 */
  function seen(id) {
    const key = normalizeId(id);
    if (key === null) return false;

    const ts = currentTime();
    prune(ts);

    const expiresAt = entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= ts) {
      // 防御：时钟回拨等极端情况下队列可能不再是过期顺序。
      entries.delete(key);
      return false;
    }
    return true;
  }

  /** 记住一个 id。重复记住 = 刷新过期时间并移到队尾（视为最新）。 */
  function remember(id) {
    const key = normalizeId(id);
    if (key === null) return;

    const ts = currentTime();
    prune(ts);

    if (entries.has(key)) entries.delete(key);
    entries.set(key, ts + ttl);

    // 超上限：淘汰最旧的（队头）
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /** 当前有效（未过期）条目数 */
  function size() {
    prune(currentTime());
    return entries.size;
  }

  return { seen, remember, size };
}
