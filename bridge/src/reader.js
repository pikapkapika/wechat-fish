// reader-api.py exposes push as SSE, not JSON polling: no since parameter,
// replacement cursor parameter, event id, or replay cursor exists. push({ since })
// keeps one subscription and returns the next parsed JSON event (since is ignored).
// Events before subscription are not replayed; callers must deduplicate rawid.
export function createReader({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const base = baseUrl.replace(/\/+$/, '');
  let iterator;
  let buffer = '';
  let decoder = new TextDecoder();
  let pending = Promise.resolve();
  // 半开连接保护：服务端认为还连着，但数据再也不来。没有超时的话会永远等下去，
  // 表现就是"群里在聊，她一条都没收到"。超过 SSE_IDLE_MS 没数据就当断线重连。
  const SSE_IDLE_MS = 90_000;
  // reader 在推送队列满时会把订阅者 discard 掉，但 TCP 还连着、心跳还在发，
  // 桥接这边完全察觉不到——表现就是"群里在聊，她一条都没收到"。
  // 所以不指望服务端通知，自己定期换一条新连接。
  const SSE_MAX_AGE_MS = 60_000;
  let connectedAt = 0;
  // 最近一次收到真实数据的时刻：正在聊天时不主动换连接，避免把消息漏在重连空窗里
  let lastDataAt = 0;

  async function request(route) {
    const response = await fetchImpl(base + route, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response;
  }
  async function json(route) {
    return (await request(route)).json();
  }
  async function nextEvent() {
    const route = '/api/v1/push/messages';
    try {
      if (!iterator) {
        connectedAt = Date.now();
        const response = await request(route);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new Error(`${route}: expected text/event-stream`);
        }
        iterator = response.body[Symbol.asyncIterator]();
      }
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) {
            lastDataAt = Date.now();
            return JSON.parse(data);
          }
          continue;
        }
        const idleMs = connectedAt ? Date.now() - Math.max(lastDataAt, connectedAt) : 0;
        if (connectedAt && Date.now() - connectedAt > SSE_MAX_AGE_MS && idleMs > 15_000) {
          throw new Error(route + ': SSE max age, 主动换连接');
        }
        const idle = new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(route + ': SSE idle timeout')), SSE_IDLE_MS);
          if (typeof timer.unref === 'function') timer.unref();
        });
        const { value, done } = await Promise.race([iterator.next(), idle]);
        if (done) throw new Error(`${route}: SSE stream ended`);
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 256000) throw new Error(`${route}: SSE event too large`);
      }
    } catch (error) {
      const current = iterator;
      iterator = undefined;
      buffer = '';
      decoder = new TextDecoder();
      try { await current?.return?.(); } catch { /* Preserve original failure. */ }
      throw error;
    }
  }
  return {
    status: () => json('/api/v1/reader/status'),
    push({ since } = {}) {
      void since;
      const result = pending.then(nextEvent);
      pending = result.catch(() => {});
      return result;
    },
    sessions: () => json('/api/v1/sessions?limit=500'),
    contacts: () => json('/api/v1/contacts'),
    messages: (talker, limit = 100) =>
      json('/api/v1/messages?talker=' + encodeURIComponent(talker) + '&limit=' + encodeURIComponent(limit)),
    stickers: conversationKey => json('/api/v1/stickers?conversationKey=' + encodeURIComponent(conversationKey)),
  };
}
