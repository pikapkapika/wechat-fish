// 定时自动打标：每 1 小时扫一遍图库，把还没有标签的新图补上。
//
// 为什么要它：群友每发一个表情，reader 就会下载到 stickers/outgoing（实测一天 +85 张），
// 但没有任何东西会给它们打标签，挑图只能靠猜。这里调插件自己的 /caption 接口补标，
// 结果合并进 ~/.dsh-fish/wechat/sticker-labels.json。
//
// 设计取舍：
// - 有回复在途时跳过这一轮（不和对话抢模型额度）
// - 每轮限量（默认 15 张），够追上一天的增量，又不会一次跑太久
// - 写文件前重读一次再合并，避免和手动脚本互相覆盖

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IMAGE_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);

function walkImages(dir, out, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkImages(full, out, depth + 1);
    else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
}

export function listCandidates({ outgoingDir, packsDir }) {
  const files = [];
  if (outgoingDir) {
    try {
      for (const entry of fs.readdirSync(outgoingDir, { withFileTypes: true })) {
        if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) files.push(path.join(outgoingDir, entry.name));
      }
    } catch { /* 目录不存在就跳过 */ }
  }
  if (packsDir) walkImages(packsDir, files);
  return files;
}

function readLabels(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.items && typeof data.items === 'object' ? data : { version: 1, items: {} };
  } catch {
    return { version: 1, items: {} };
  }
}

function writeLabels(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch { /* 写不进去不影响对话 */ }
}

export function createAutoLabeler({
  baseUrl, token, outgoingDir, packsDir, labelsFile,
  intervalMs = 60 * 60 * 1000, batch = 15, timeoutMs = 40000,
  fetchImpl = globalThis.fetch, log = () => {}, isBusy = () => false, now = Date.now,
} = {}) {
  let timer = null;
  let running = false;
  let disabled = false;

  async function caption(file) {
    const res = await fetchImpl(String(baseUrl).replace(/\/+$/, '') + '/caption', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ path: file }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error || 'HTTP ' + res.status };
    return { ok: true, caption: String(data.caption ?? ''), tags: data.tags ?? [], emotion: String(data.emotion ?? '') };
  }

  async function runOnce() {
    if (running || disabled) return { ok: true, labelled: 0, skipped: true };
    if (isBusy()) return { ok: true, labelled: 0, skipped: 'busy' };
    running = true;
    let labelled = 0;
    try {
      const labels = readLabels(labelsFile);
      const candidates = listCandidates({ outgoingDir, packsDir });
      const todo = candidates
        .filter((file) => !labels.items[file])
        .sort((a, b) => {
          try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
        })
        .slice(0, Math.max(1, Number(batch) || 15));
      if (!todo.length) return { ok: true, labelled: 0 };

      for (const file of todo) {
        const result = await caption(file);
        if (!result.ok) {
          if (result.error === 'MODEL_IMAGE_INPUT_UNSUPPORTED') { disabled = true; break; }
          continue;
        }
        // 合并写：先重读，避免覆盖手动脚本刚写进去的条目
        const fresh = readLabels(labelsFile);
        fresh.items[file] = { ...result, source: file.includes('meme-packs') ? 'meme' : 'wechat', at: now() };
        writeLabels(labelsFile, fresh);
        labelled += 1;
      }
      if (labelled) log('[labels] 自动补标 ' + labelled + ' 张');
      return { ok: true, labelled };
    } catch (error) {
      log('[labels] 自动打标失败: ' + (error?.message ?? error));
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      running = false;
    }
  }

  return {
    start({ delayMs = 5 * 60 * 1000 } = {}) {
      if (timer) return;
      const first = setTimeout(() => { void runOnce(); }, Math.max(0, delayMs));
      if (typeof first.unref === 'function') first.unref();
      timer = setInterval(() => { void runOnce(); }, Math.max(60_000, Number(intervalMs) || 3_600_000));
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
    get disabled() { return disabled; },
  };
}
