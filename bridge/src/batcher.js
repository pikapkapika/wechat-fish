/**
 * 攒批器（8s 静默 / 40 条封顶 → 一批送 /turn）。
 *
 * 契约：
 *   createBatcher({ silenceMs = 8000, maxRows = 40, now = Date.now }) →
 *     { push(event) → { flush: boolean, batch?: object },
 *       tick(nowMs) → batch | null,
 *       flushNow() → batch | null,
 *       pendingCount() → number }
 *
 * 语义要点：
 * - 只有 kind === 'message' 且是入站（不是自己发的）的事件才进批；其余事件忽略，
 *   返回 { flush: false }，且不影响正在攒的批。
 * - 事件至少要有 { key, name, kind, sender, senderName, text, at }；
 *   text 为空且没有 image 的丢弃（清空类的系统消息、纯占位事件）。
 * - 同一批只来自同一个 key。不同 key 的事件到来时先把旧批交出去（返回值就是旧批），
 *   新事件另开一批。
 * - 静默以「已入批事件 at 的最大值」为准：tick(nowMs) 里 nowMs - lastAt >= silenceMs
 *   就交批。不看真实时钟，测试直接传假时间，整套用例毫秒级跑完。
 * - 条数达到 maxRows 时 push 当场交批（含第 maxRows 条），之后同 key 继续攒新批。
 * - flushNow() 强制交批（关停用）；没有残留批时返回 null。
 * - 批对象形状固定为 { key, name, kind, rows }；rows 放的是原事件对象本身
 *   （不复制、不改写），顺序就是入批顺序，最多 maxRows 条。
 *
 * 实现补充（契约外、向后兼容）：
 * - 额外允许注入 now / selfId：前者用于 at 缺失时取时间，后者把 sender 相同的
 *   消息当成「自己发的」直接丢掉。
 * - 缺 key（空串或非字符串）的事件无法归批，忽略，绝不抛异常拖垮主循环。
 * - 批的 kind 是会话类型（group / private，/turn 要的形状），与事件的 kind
 *   （固定 'message'，表示事件种类）不是一回事：优先取事件上的
 *   sessionType / conversationKind / chatKind / roomKind，
 *   其次按 key 前缀（wechat:group: / wechat:private: / :friend: / :contact:）推导，
 *   都没有就兜底 'private'。
 * - maxRows <= 0 会兜到 1，避免「攒到 0 条就出批」这种空批循环。
 * - 一次 push 只能交回一个批，所以「换 key 且新批恰好已满」（只可能发生在
 *   maxRows === 1）时先交旧批，新批留在 pending，tick() / flushNow() 会取走它。
 */

const DEFAULT_SILENCE_MS = 8000;
const DEFAULT_MAX_ROWS = 40;

/** 视为「自己发的」的布尔标记；1 也算，兼容 WeChat 的 isSend 数字位 */
const OUTBOUND_FLAGS = ['isSend', 'isSelf', 'fromSelf', 'self', 'outbound'];

/** 会话类型字段，按优先级取第一个合法的 group / private */
const CONVERSATION_KIND_FIELDS = ['sessionType', 'conversationKind', 'chatKind', 'roomKind'];

/** 只接受有限数字，其余回退默认值 */
function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** text 视为「有内容」：非空字符串（纯空白算空） */
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 入站过滤：自己发出去的消息不进批 */
function isOutbound(event) {
  for (const flag of OUTBOUND_FLAGS) {
    const value = event[flag];
    if (value === true || value === 1) return true;
  }
  const direction = typeof event.direction === 'string' ? event.direction.toLowerCase() : '';
  return direction === 'out' || direction === 'outbound' || direction === 'send';
}

/** 会话类型：事件字段 > key 前缀 > 'private' */
function conversationKindOf(event, key) {
  for (const field of CONVERSATION_KIND_FIELDS) {
    const value = event[field];
    if (value === 'group' || value === 'private') return value;
  }
  if (key.includes(':group:')) return 'group';
  if (key.includes(':private:') || key.includes(':friend:') || key.includes(':contact:')) {
    return 'private';
  }
  return 'private';
}

export function createBatcher({
  silenceMs = DEFAULT_SILENCE_MS,
  maxRows = DEFAULT_MAX_ROWS,
  now = Date.now,
  selfId = '',
  groupSilenceMs = null,
} = {}) {
  const silence = Math.max(0, finiteNumber(silenceMs, DEFAULT_SILENCE_MS));
  // 群里同一个人常连着发几句（想到一句发一句），2 秒就切批会把一段话剁成几段，
  // 她就会只接最后半句。群单独给一个更长的静默窗口；没配就沿用 silence。
  const groupSilence = groupSilenceMs === null || groupSilenceMs === undefined
    ? silence
    : Math.max(0, finiteNumber(Number(groupSilenceMs), silence));
  // 0 条即封顶会让 push 交出空批，兜到 1；非数字回退默认值。
  const cap = Math.max(1, Math.floor(finiteNumber(maxRows, DEFAULT_MAX_ROWS)));
  const clock = typeof now === 'function' ? now : Date.now;
  const ownId = typeof selfId === 'string' ? selfId : '';

  /** 当前正在攒的批；没有残留时是 null（永远不为空批） */
  let pending = null;

  /** 读时钟；坏时钟不至于让攒批器崩掉 */
  function currentTime() {
    const t = clock();
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
  }

  /** 把正在攒的批交出去，并清空 pending */
  function drain() {
    if (pending === null) return null;
    const batch = { key: pending.key, name: pending.name, kind: pending.kind, rows: pending.rows };
    pending = null;
    return batch;
  }

  /**
   * 过滤并归一一条事件：不进批返回 null，进批返回该事件的归批信息。
   * 只读事件，不改写。
   */
  function accept(event) {
    if (event === null || typeof event !== 'object') return null;
    if (event.kind !== 'message') return null;
    if (isOutbound(event)) return null;

    const key = event.key;
    if (typeof key !== 'string' || key.length === 0) return null;

    const sender = typeof event.sender === 'string' ? event.sender : '';
    if (ownId && sender === ownId) return null;

    // 没正文又没图 → 丢弃（图片只传引用，非空对象/false 都按真值判断）
    if (!hasText(event.text) && !event.image) return null;

    return {
      key,
      name: typeof event.name === 'string' ? event.name : '',
      kind: conversationKindOf(event, key),
      at: finiteNumber(event.at, currentTime()),
    };
  }

  /**
   * 收一条事件。
   * @returns {{flush: boolean, batch?: object}}
   */
  function push(event) {
    const row = accept(event);
    if (row === null) return { flush: false };

    // 换会话：旧批先出（旧批一定非空，pending 不为空批）
    const older = pending !== null && pending.key !== row.key ? drain() : null;

    if (pending === null) {
      pending = {
        key: row.key,
        name: row.name,
        kind: row.kind,
        rows: [],
        lastAt: row.at,
        // 批的静默窗口跟着会话类型走（群更长），换会话时重新取
        silence: row.kind === 'group' ? groupSilence : silence,
      };
    }

    pending.rows.push(event);
    // at 取最大值：数据库时间戳偶尔乱序时不至于提前出批
    if (row.at > pending.lastAt) pending.lastAt = row.at;

    // 一次 push 只能交回一个批：换 key 时优先交旧批，
    // 新批若恰好满了（maxRows === 1）留给 tick() / flushNow()。
    if (older !== null) return { flush: true, batch: older };

    if (pending.rows.length >= cap) return { flush: true, batch: drain() };

    return { flush: false };
  }

  /**
   * 推进时钟：静默到期就交批。nowMs 省略时读注入的 now。
   * @returns {object|null}
   */
  function tick(nowMs) {
    if (pending === null) return null;
    const ts = finiteNumber(nowMs, currentTime());
    if (ts - pending.lastAt >= pending.silence) return drain();
    return null;
  }

  /** 强制交批（关停）；没有残留批返回 null */
  function flushNow() {
    return drain();
  }

  /** 当前批里攒了几条（没有批时为 0） */
  function pendingCount() {
    return pending === null ? 0 : pending.rows.length;
  }

  return { push, tick, flushNow, pendingCount };
}
