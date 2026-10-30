/**
 * server.js —— 给微信桥接用的 HTTP 入口
 *
 * 为什么不用 dsh-fish 原有的 /observe 路由：
 * 那条是给人看的（面板），要的是「浏览器 + 会话」。这里要的是「机器 + Bearer」，
 * 一轮一个请求，必须可并发安全、可超时、可拒绝。
 *
 * 契约（与 WeChatAgent 的桥接侧对齐，但只保最小面）：
 *   POST /turn   {key,name,kind,rows:[{text,senderName,mentionMe,pat,image,at}]}
 *                → {kind:'reply'|'silent', text, meta}
 *   GET  /health → {ok:true, day, stage}
 *
 * 串行：同一时刻只跑一轮。她的记忆是单条事件流，并发写会把事件顺序搞乱。
 */

import http from 'node:http';
import { captionImage } from './caption.js';

const DEFAULT_PORT = 11231;
const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createWechatServer({ token, port = DEFAULT_PORT, runTurn, ctx, provider, model, status = () => ({}), log = () => {} } = {}) {
  if (typeof runTurn !== 'function') throw new Error('createWechatServer 需要 runTurn');

  let queue = Promise.resolve();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, ...status() });
    }
    const isCaption = url.pathname === '/caption';
    if (req.method !== 'POST' || (!isCaption && url.pathname !== '/turn')) {
      return send(res, 404, { error: 'not_found' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(res, 401, isCaption ? { ok: false, error: 'UNAUTHORIZED' } : { error: 'unauthorized' });
    }

    let batch;
    try {
      batch = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, isCaption ? { ok: false, error: 'INVALID_JSON' } : { error: 'invalid_json' });
    }

    // 串行：一轮跑完再跑下一轮
    const job = queue.then(async () => {
      try {
        if (isCaption) {
          if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return send(res, 400, { ok: false, error: 'CAPTION_INVALID_INPUT' });
          const result = await captionImage({ ctx, provider, model, file: batch.path, imageId: batch.imageId });
          return send(res, result.ok ? 200 : 400, result);
        }
        const result = await runTurn(batch);
        send(res, 200, result);
      } catch (error) {
        log('[wechat] turn failed', error?.message ?? error);
        send(res, 500, isCaption ? { ok: false, error: 'CAPTION_FAILED' } : { error: String(error?.message ?? 'turn_failed').slice(0, 120) });
      }
    });
    queue = job.catch(() => {});
    await job;
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      });
    },
    dispose() {
      return new Promise((resolve) => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        server.close(() => resolve());
      });
    },
  };
}
