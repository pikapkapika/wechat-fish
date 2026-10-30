// 会话 id 映射：与 WeChatAgent 的 scripts/hook-onebot.mjs 保持**逐字节一致**。
//
// 为什么不直接 import 它：hook-onebot.mjs 是带副作用的入口脚本（顶层就连 WS、
// 起定时器），import 会把整个适配器拉起来，和我们的桥接抢同一批消息。
// 所以这里按原实现抄一遍，并在测试里对齐行为。
//
// 原始实现（hook-onebot.mjs:16-23）：
//   onebotId = value => Number(sha256(value).readBigUInt64BE(0) % 2147483647n + 1n)
//   conversationId = (wxid, name, mappedId) => {
//     if (mappedId !== undefined) { 校验数字后返回 Number(mappedId) }
//     return onebotId(wxid.includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid)
//   }

import crypto from 'node:crypto';

export function onebotId(value) {
  return Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);
}

export function conversationId(wxid, name, mappedId) {
  if (mappedId !== undefined) {
    if (!/^[1-9]\d*$/.test(String(mappedId)) || !Number.isSafeInteger(Number(mappedId))) {
      throw new Error('INVALID_CONVERSATION_ID');
    }
    return Number(mappedId);
  }
  return onebotId(
    String(wxid).includes('@chatroom')
      ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim()
      : wxid,
  );
}
