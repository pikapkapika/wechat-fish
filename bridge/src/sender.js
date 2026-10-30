import path from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
// Native acceptance is not delivery: only a new outgoing Reader receipt counts.
// conversationId is injected from hook-onebot.mjs; never guess its mapping here.
export function createSender({
  reader, hook, pollMs = 400, receiptTimeoutMs = 18000,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, conversationId,
} = {}) {
  if (typeof reader?.sessions !== 'function' || typeof reader?.messages !== 'function' ||
      typeof hook?.post !== 'function' || typeof conversationId !== 'function' ||
      typeof sleep !== 'function' || typeof now !== 'function' ||
      !Number.isFinite(pollMs) || pollMs <= 0 ||
      !Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs < 0) {
    throw new TypeError('INVALID_SENDER_OPTIONS');
  }

  function validateTarget(kind, target) {
    if (!['group', 'private'].includes(kind) ||
        !['string', 'number'].includes(typeof target) || !String(target).trim() ||
        (typeof target === 'number' && !Number.isFinite(target))) {
      throw new TypeError('INVALID_TARGET');
    }
  }

  async function messages(wxid) {
    const result = await reader.messages(wxid);
    const rows = Array.isArray(result) ? result : result?.messages;
    if (!Array.isArray(rows)) throw new Error('INVALID_RECEIPT_RESPONSE');
    return rows;
  }

  // 串行发送：并发两次相同文本会在提交前拿到同一份 baseline，只有一条回执时两边都会认领成功
  // （把失败记成成功的审查问题）。整条 baseline→提交→回执 放进队列，一次只跑一条。
  let sendQueue = Promise.resolve();
  function send(kind, target, route, body, matches, unconfirmed) {
    const run = sendQueue.then(() => doSend(kind, target, route, body, matches, unconfirmed));
    sendQueue = run.then(() => {}, () => {});
    return run;
  }

  async function doSend(kind, target, route, body, matches, unconfirmed) {
    let submitted = false;
    try {
      const data = await reader.sessions();
      const sessions = Array.isArray(data) ? data : data?.sessions;
      if (!Array.isArray(sessions)) throw new Error('INVALID_SESSIONS_RESPONSE');
      const targets = sessions.filter(s => typeof s?.username === 'string' && s.username &&
        (s.username.includes('@chatroom') ? 'group' : 'private') === kind &&
        String(conversationId(s.username, s.displayName, s.conversationId)) === String(target));
      if (targets.length !== 1) return { ok: false, error: 'TARGET_MAPPING_AMBIGUOUS_OR_MISSING' };
      const wxid = targets[0].username;
      const baseline = new Set((await messages(wxid)).map(row => String(row.localId)));
      submitted = true;
      const accepted = await hook.post(route, { wxidorgid: wxid, ...body });
      if (accepted?.ret !== 0) return { ok: false, error: 'NATIVE_SEND_REJECTED' };
      const deadline = now() + receiptTimeoutMs;
      do {
        const rows = await messages(wxid);
        const row = rows.find(row => row?.isSend &&
          Number.isSafeInteger(Number(row.localId)) && Number(row.localId) > 0 &&
          !baseline.has(String(row.localId)) && Number(row.serverId) > 0 && matches(row));
        if (row) return { ok: true, messageId: Number(row.localId) };
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
      } while (now() < deadline);
      return { ok: false, error: unconfirmed };
    } catch (error) {
      // Once submission starts, transport/receipt failures are uncertain, not safe to retry.
      if (error?.code === 'NATIVE_HTTP_ERROR') {
        return { ok: false, error: 'NATIVE_HTTP_ERROR', detail: error.message, status: error.status };
      }
      return { ok: false, error: submitted ? unconfirmed : (error?.message || 'SENDER_FAILED') };
    }
  }

  return {
    sendText({ kind, target, text } = {}) {
      validateTarget(kind, target);
      if (typeof text !== 'string' || !text.trim()) throw new TypeError('INVALID_TEXT');
      return send(kind, target, '/SendTextMsg', { msg: text }, row =>
        (row.localType === 1 || row.localType === undefined) &&
        String(row.fullText ?? row.content ?? row.parsedContent ?? '').trim() === text.trim(),
      'TEXT_DELIVERY_UNCONFIRMED');
    },
    sendSticker({ kind, target, sticker } = {}) {
      validateTarget(kind, target);
      if (!sticker || typeof sticker.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(sticker.md5) ||
          typeof sticker.path !== 'string' || !sticker.path.trim()) {
        throw new TypeError('INVALID_STICKER');
      }
      // 原生接口要 {wxidorgid, sticker:{md5,productid,len,type,width,height}, path}
      const fields = {
        md5: sticker.md5,
        productid: String(sticker.productid ?? ''),
        len: Number(sticker.len ?? 0),
        type: Number(sticker.type ?? 1),
        width: Number(sticker.width ?? 0),
        height: Number(sticker.height ?? 0),
      };
      const wantedMd5 = String(sticker.md5 || '').toLowerCase();
      // Hook 的 /SendStickerMsg 有硬编码白名单：只认 %APPDATA%\state\stickers\outgoing
      // 所以先把文件挪到那儿（md5 命名），再发。
      let sendPath = sticker.path;
      try {
        const home = process.env.USERPROFILE || process.env.HOME || '';   // 桥接进程环境里没有 APPDATA，用 USERPROFILE 拼绝对路径
        const allowed = path.join(home, 'AppData', 'state', 'stickers', 'outgoing');
        mkdirSync(allowed, { recursive: true });
        const ext = path.extname(sticker.path) || '.gif';
        const moved = path.join(allowed, wantedMd5 + ext);
        if (path.resolve(moved) !== path.resolve(sticker.path)) {
          copyFileSync(sticker.path, moved);
        }
        sendPath = moved;
      } catch (e) { console.log('[sticker] copy failed: ' + (e && e.message)); }
      console.log('[sticker] sendPath=' + sendPath + ' exists=' + (function(){try{return require('node:fs').existsSync(sendPath)}catch{return 'n/a'}})());
      return send(kind, target, '/SendStickerMsg', { sticker: fields, path: sendPath }, row => {
        const got = String(row.stickerMd5 ?? row.md5 ?? '').toLowerCase();
        if (wantedMd5 && got && got !== wantedMd5) return false;
        const looksSticker = row.localType === 47 || row.localType === 34359738417 ||
          (row.localType === 49 && row.stickerKind === 'appmsg-8') ||
          row.mediaType === 'sticker' || Boolean(row.sticker) ||
          !String(row.fullText ?? row.content ?? row.parsedContent ?? '').trim();
        return Boolean(looksSticker);
      }, 'STICKER_DELIVERY_UNCONFIRMED');
    },
  };
}
