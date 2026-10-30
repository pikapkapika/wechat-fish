// Hook（原生发送）的 HTTP 客户端。
//
// 实测协议（2026-10-27，读 wechatagent_hook.cpp:255-278）：
//   POST /SendTextMsg  { wxidorgid, msg }
//   Headers: Authorization: Bearer <native-token>
//            X-WeChatAgent-Account: <数据库账号>   ← 必填，服务端会比对 DatabaseAccounts()
//   → { ret: 0, retmsg: 'accepted' } / 409 {"ret":1,"error":"Version or account mismatch"}
//
// 注意：ret=0 只代表「被接受」，不代表送达；送达要靠 Reader 的数据库回执（sender.js 负责）。

export function createHook({ baseUrl, token, fetchImpl = globalThis.fetch, account = '' } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  let cachedAccount = account || '';

  async function health() {
    const route = '/WeChatAgent/health';
    const response = await fetchImpl(base + route, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response.json();
  }

  /** 账号从 health 的 databaseAccounts 取，取不到就再试一次（不缓存失败）。 */
  async function resolveAccount() {
    if (cachedAccount) return cachedAccount;
    const info = await health();
    const list = Array.isArray(info?.databaseAccounts) ? info.databaseAccounts : [];
    if (list.length === 1) cachedAccount = String(list[0]);
    return cachedAccount;
  }

  return {
    async post(route, body) {
      const accountId = await resolveAccount();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      if (accountId) headers['X-WeChatAgent-Account'] = accountId;
      const response = await fetchImpl(base + route, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`${route}: HTTP ${response.status} ${detail.slice(0, 120)}`.trim());
        // Preserve rejection evidence; a network failure remains uncertain.
        error.code = 'NATIVE_HTTP_ERROR';
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
    health,
    account: resolveAccount,
    // 这两个保留为「明确不支持」的占位：发送走 sender.js 的数据库回执闭环。
    async sendText() {
      return { ok: false, error: 'USE_SENDER: 发文本请走 sender.sendText（含回执）' };
    },
    async sendSticker() {
      return { ok: false, error: 'USE_SENDER: 发表情请走 sender.sendSticker（含回执）' };
    },
    async receipt() {
      throw new Error('HOOK_RECEIPT_UNSUPPORTED: 回执请用 Reader /api/v1/messages');
    },
  };
}
