import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { findWeChatAgentHome } from './roots.js';

/** Keep image selection identical to the visible, incoming context. */
export function imageRows(batch) {
  return (Array.isArray(batch?.rows) ? batch.rows : [])
    .filter(row => row && row.outgoing !== true).slice(-40)
    .filter(row => row.image || row.imageId);
}

/** Vision is optional: every failure leaves an explicit, non-speculative text block. */
export function acceptImage(content, id, batchKey) {
  if (!content || content.imageId !== id || content.conversationKey !== batchKey) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(content.mime)) return null;
  if (typeof content.b64 !== 'string' || content.b64.length > 1100000) return null;
  const data = Buffer.from(content.b64, 'base64');
  if (!data.length || data.length > 768 * 1024 || data.toString('base64') !== content.b64) return null;
  if (createHash('sha256').update(data).digest('hex') !== content.sha256) return null;
  return { data, mime: content.mime, thumbnail: content.sourceQuality === 'thumbnail' };
}

export async function imageBlocks({ ctx, batch, provider, model, root = findWeChatAgentHome(), fetchImpl = globalThis.fetch, timeoutMs = 8000, log = () => {} } = {}) {
  const rows = imageRows(batch);
  log('进入 imageBlocks：rows=' + rows.length + ' key=' + (batch && batch.key) + ' 样例=' + JSON.stringify((batch && batch.rows || []).slice(0, 2).map(r => ({ image: r && r.image, imageId: r && r.imageId ? String(r.imageId).slice(0, 8) : '' }))));
  if (!rows.length) return [];
  const fallback = (index) => {
    const row = rows[index];
    const isSticker = /表情包/.test(String(row && row.text ? row.text : ''));
    return isSticker
      ? { type: 'text', text: '[对方发了个表情包，就当对方在卖萌或逗你，顺着当下的话题自然接话，不要猜具体画面。不要描述取图失败，不要说“你发的是个框”“画面没取到”等话，也不要问对方要图或要求重发。]' }
      : { type: 'text', text: `[附图 ${index + 1} 未提供画面，不要猜测图片内容。]` };
  };
  const blocks = rows.map((_, index) => [fallback(index)]);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('IMAGE_TIMEOUT')); }, Math.min(8000, Math.max(1, Number(timeoutMs) || 8000)));
  });
  const bounded = task => Promise.race([Promise.resolve().then(task), deadline]);
  try {
    const llm = ctx?.get?.('llm');
    const attachments = ctx?.get?.('attachments');
    if (!llm?.resolveModelInfo || !attachments?.saveImage) { log('宿主没有 llm/attachments 服务，降级为文字'); return blocks.flat(); }
    const info = await bounded(() => llm.resolveModelInfo(provider, model, controller.signal));
    if (!info?.inputModalities?.includes('image')) { log('模型不支持图片输入（inputModalities=' + JSON.stringify(info?.inputModalities ?? null) + '），降级为文字'); return blocks.flat(); }
    const io = JSON.parse((await bounded(() => readFile(path.join(root, 'state', 'wechat-io-config.json'), 'utf8'))).replace(/^\uFEFF/, ''));
    const base = new URL(io.reader_base_url);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || typeof io.reader_token !== 'string' || !io.reader_token) return blocks.flat();
    await Promise.all(rows.slice(0, 2).map(async (row, index) => {
      try {
        // A missing row.imageId must be supplied by the bridge; never use a message id.
        const id = row.imageId;
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !batch?.key) { log('图片 id 无效或缺少 batch.key: ' + JSON.stringify(id)); return; }
        const response = await bounded(() => fetchImpl(base.origin + '/api/v1/images/' + id, {
          headers: { Authorization: 'Bearer ' + io.reader_token }, redirect: 'error', signal: controller.signal,
        }));
        if (!response.ok) {
          // 表情包经常第一次取不到（微信 CDN 拒绝），reader 提供了 retry 接口，试一次
          log('取图 HTTP ' + response.status + ' id=' + id.slice(0, 8) + '，尝试 retry');
          try {
            await bounded(() => fetchImpl(base.origin + '/api/v1/images/' + id + '/retry', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + io.reader_token },
              redirect: 'error',
              signal: controller.signal,
            }));
            const again = await bounded(() => fetchImpl(base.origin + '/api/v1/images/' + id, {
              headers: { Authorization: 'Bearer ' + io.reader_token }, redirect: 'error', signal: controller.signal,
            }));
            if (!again.ok) { log('retry 后仍失败 HTTP ' + again.status); return; }
            const retried = await bounded(() => again.json());
            const accepted = acceptImage(retried, id, batch.key);
            if (accepted) {
              const retryAttachment = await bounded(() => attachments.saveImage({ data: accepted.data, mediaType: accepted.mime, name: 'wechat-image-' + id.slice(0, 12) }));
              if (retryAttachment) { blocks[index] = [{ type: 'text', text: '[附图 ' + (index + 1) + ']' }, { type: 'image', attachment: retryAttachment }]; log('retry 成功 id=' + id.slice(0, 8)); return; }
            }
            log('retry 返回内容不可用');
            return;
          } catch (retryError) {
            log('retry 失败：' + (retryError && retryError.message ? retryError.message : String(retryError)));
            return;
          }
        }
        const content = await bounded(() => response.json());
        if (content.imageId !== id || content.conversationKey !== batch.key || !['image/png', 'image/jpeg', 'image/webp'].includes(content.mime) || typeof content.b64 !== 'string' || content.b64.length > 1100000) { log('返回内容不合规：id匹配=' + (content.imageId === id) + ' key匹配=' + (content.conversationKey === batch.key) + ' mime=' + content.mime + ' b64=' + (typeof content.b64) + ' len=' + (content.b64 ? content.b64.length : 0)); return; }
        const data = Buffer.from(content.b64, 'base64');
        if (!data.length || data.length > 768 * 1024 || data.toString('base64') !== content.b64 || createHash('sha256').update(data).digest('hex') !== content.sha256) { log('图片字节校验失败: size=' + data.length + ' sha匹配=' + (createHash('sha256').update(data).digest('hex') === content.sha256)); return; }
        const attachment = await bounded(() => attachments.saveImage({ data, mediaType: content.mime, name: 'wechat-image-' + id.slice(0, 12) }));
        if (controller.signal.aborted || !attachment) { log('附件保存失败或已超时 aborted=' + controller.signal.aborted + ' attachment=' + Boolean(attachment)); return; }
        blocks[index] = [{ type: 'text', text: `[附图 ${index + 1}]${content.sourceQuality === 'thumbnail' ? ' 这里是缩略图，细节和小字可能不清楚。' : ''} 看完直接说你的反应，别复述画面。` }, { type: 'image', attachment }];
      } catch (error) { log('取图失败：' + (error && error.message ? error.message : String(error))); }
    }));
  } catch (error) { log('识图整体失败：' + (error && error.message ? error.message : String(error))); }
  finally { clearTimeout(timer); }
  return blocks.flat();
}
