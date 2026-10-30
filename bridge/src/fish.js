// 客户端：调用 dsh-fish 的微信通道（POST /turn）。
// 约定：任何失败都退化成「沉默」，绝不让桥接崩掉——她这次不说话，比整条链路挂掉好。

export function createFish({ baseUrl, token, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('createFish 需要 baseUrl');

  async function post(body, signal) {
    return fetchImpl(base + '/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  }

  return {
    async turn(batch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 240000)); // 宿主画图通常需要一分钟以上
      try {
        const response = await post({
          key: batch?.key ?? '',
          name: batch?.name ?? '',
          kind: batch?.kind ?? 'group',
          rows: (batch?.rows ?? []).map((row) => ({
            id: String(row?.id ?? ''),
            sender: String(row?.sender ?? ''),
            senderName: String(row?.senderName ?? row?.sender ?? ''),
            text: String(row?.text ?? ''),
            at: Number(row?.at ?? 0) || undefined,
            mentionMe: row?.mentionMe === true,
            pat: row?.pat === true,
            image: row?.image === true,
            // 识图要用：reader 的图片 id（64 位十六进制），漏了就只能看到占位文字
            imageId: String(row?.imageId ?? ''),
          })),
        }, controller.signal);
        if (!response.ok) return { kind: 'silent', text: '', error: `HTTP ${response.status}` };
        const data = await response.json();
        // 引擎会返回 reply / sticker / silent 三种；以前把 sticker 一律当 silent，
        // 导致表情分支永远走不到（表？发不出来就是这个原因）。
        const kind = data?.kind === 'sticker' ? 'sticker' : data?.kind === 'reply' ? 'reply' : 'silent';
        return { kind, text: kind === 'reply' ? String(data?.text ?? '') : '', emotion: data?.emotion, meta: data?.meta, ...(data?.stickerFile ? { stickerFile: String(data.stickerFile) } : {}), ...(data?.reason ? { reason: data.reason } : {}) };
      } catch (error) {
        return { kind: 'silent', text: '', error: String(error?.message ?? error) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
