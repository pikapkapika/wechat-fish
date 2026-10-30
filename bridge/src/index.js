// 主循环：SSE 入站 → 攒批 → dsh-fish 决策 → 限流 → 原生发送 → 回执
//
// 这一层刻意很薄：它不判断该不该回、不回什么、用什么表情——那些都交给 dsh-fish。
// 它只负责三件不能出错的事：不重复、不发太快、发完要确认。

import * as http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listLocalMemes, pickMeme, fetchRemote, importToOutgoing } from './memes.js';
import { loadLabels, pickByLabel } from './meme-labels.js';
import { createAutoLabeler } from './auto-label.js';
import os from 'node:os';

const DEFAULT_MEMES = {
  enabled: false,
  packsDir: '',
  remoteManifests: [],
  webFillLimit: 5,
};
import { resolvePaths } from './paths.js';
import { createReader } from './reader.js';
import { createHook } from './hook.js';
import { createSender } from './sender.js';
import { createBatcher } from './batcher.js';
import { createDedupe } from './dedupe.js';
import { createPacing } from './pacing.js';
import { createFish } from './fish.js';
import { createStickerPicker } from './stickers.js';
import { conversationId } from './conversation.js';
import { createAdmin } from './admin.js';

/** 微信会话 key → {kind,target} */
export function splitKey(key) {
  const match = /^wechat:(group|private):(\d+)$/.exec(String(key ?? ''));
  return match ? { kind: match[1], target: match[2] } : null;
}

/**
 * 微信里 @ 她的几种叫法。装好之后在 config.json 的 `mentionAliases` 里填这台机器上
 * 她自己的微信昵称（例如 ["小助手"]）；留空 = 不靠正文判断 @，只认 reader 给的
 * mentionMe 字段。这里刻意不带任何默认名字：随包分发的版本不包含某个人的身份。
 */
const DEFAULT_MENTION_ALIASES = [];

function mentionPattern(aliases) {
  const names = (Array.isArray(aliases) ? aliases : DEFAULT_MENTION_ALIASES).map(String).filter(Boolean);
  if (!names.length) return null;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('@\\s*(?:' + escaped.join('|') + ')');
}

/** SSE 事件 → 批处理事件。按 reader-api.py 的真实推送结构归一。
 *
 * 真实样本（2026-10-27 抓到的）：
 * {
 *   "event":"message.new","sessionId":"12345678901@chatroom",
 *   "conversationId":"123456789","sessionType":"group",
 *   "rawid":"4650…","groupName":"示例群","sourceName":"alice",
 *   "senderName":"alice","talkerId":"wxid_example",
 *   "content":"我一会儿看看原视频说的是什么= =","type":1,
 *   "timestamp":1793090899
 * }
 * 注意：没有 conversationKey；timestamp 是**秒**。
 */
export function normalizeEvent(raw, ownWxid = '', mentionAliases = DEFAULT_MENTION_ALIASES) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.event && raw.event !== 'message.new') return null;
  const mentionRe = mentionPattern(mentionAliases);

  const sessionType = String(raw.sessionType ?? '');
  let key = String(raw.conversationKey ?? raw.key ?? '');
  if (!key && raw.conversationId && (sessionType === 'group' || sessionType === 'private')) {
    key = `wechat:${sessionType}:${raw.conversationId}`;
  }
  const parts = splitKey(key);
  if (!parts) return null;

  const sender = String(raw.talkerId ?? raw.sender ?? raw.senderId ?? '');
  if (ownWxid && sender === ownWxid) return null;
  // 自己发的：reader 会给 isSend；没有这个字段时靠 sender 判断不了，交给白名单外的过滤
  // reader 有时用数字 1 表示自己发的；以前只认 true，自己的消息会重新进回复链路
  if (raw.isSend === true || raw.isSend === 1 || raw.isSend === '1' || raw.isSelf === true) return null;

  const type = Number(raw.type ?? raw.localType ?? 1);
  let text = String(raw.content ?? raw.text ?? raw.fullText ?? '').trim();

  // 合并转发：内容是「[合并转发聊天记录] 群聊的聊天记录」这种占位串。
  // 里面那几十条旧消息会把早就聊过的话题重新灌回她眼前（实测会让她反复纠结同一个旧梗），
  // 所以只留一个标记，不把那堆旧内容喂进去。
  const forwarded = /^\[合并转发/.test(text);
  if (forwarded) text = '[转发的旧聊天记录]';
  const image = type === 3 || raw.image === true || raw.mediaType === 'image';
  // 拍一拍的推送常常没有正文（content 为空），必须在"空消息"判断之前认出来，
  // 否则它会被当成空事件丢掉——表现就是"拍了没反应"。
  const pat = raw.pat === true || (raw.pat && typeof raw.pat === 'object') || type === 62 || type === 266287972401 || /拍一拍/.test(text);
  // 拍一拍兜底：没有正文也当成一条消息
  if (!text && pat) text = '[拍一拍] 有人拍了拍你。';
  if (!text && !image) return null;

  const seconds = Number(raw.timestamp ?? raw.createTime ?? 0);
  return {
    id: String(raw.rawid ?? raw.msgId ?? raw.localId ?? raw.id ?? ''),
    kind: 'message',
    key,
    name: String(raw.groupName ?? raw.conversationName ?? raw.sourceName ?? raw.displayName ?? ''),
    conversationKind: parts.kind,
    sender,
    senderName: String(raw.senderName ?? raw.sourceName ?? sender),
    text,
    image,
    // 插件的识图要用这个 id 去 reader 取图；没有它就只能看到"[图片]"占位
    imageId: String(raw.image?.id ?? raw.imageId ?? raw.mediaId ?? ''),
    // reader 的推送里经常没有 mentionMe 字段，正文里 @ 的是她本人时才算叫她；
    // 别人互相 @ 不算（以前只要有 @ 就算，她会被拽进一堆跟她无关的话）。
    mentionMe: raw.mentionMe === true || raw.atMe === true || (mentionRe ? mentionRe.test(text) : false),
    forwarded,
    pat,
    at: seconds > 0 ? seconds * 1000 : 0,
  };
}

export function buildStatus(startedAt = Date.now()) {
  return {
    ok: true, startedAt,
    reader: { connected: false, lastEventAt: 0, reconnects: 0 },
    fish: { connected: false, lastReplyAt: 0, lastError: '' },
    hook: { ok: false, account: '' },
    counters: { events: 0, replies: 0, silents: 0, sent: 0, failed: 0, stickers: 0 },
  };
}

export function createBridge({ config, log = console.log, components = {} } = {}) {
  const paths = resolvePaths(config, components.pathsOptions);
  if (!paths.outgoingDir) log('[paths] 找不到微信目录，表情池功能关闭');
  config = { ...config,
    memes: { ...config.memes, packsDir: paths.packsDir, pythonPath: paths.pythonPath, enabled: Boolean(paths.outgoingDir) && config.memes?.enabled },
    stickers: { ...config.stickers, dir: paths.outgoingDir || '' },
  };
  const status = buildStatus();
  const admin = components.admin ?? createAdmin({
    admins: config.admins,
    now: components.now ?? Date.now,
    ...(components.muteFile !== undefined ? { file: components.muteFile } : {}),
    log,
  });
  Object.defineProperty(status, 'mute', { enumerable: true, get: () => admin.snapshot() });
  let statusServer = null;
  function recordSend(sent, sticker = false) {
    if (sent.ok) {
      status.counters.sent++;
      if (sticker) status.counters.stickers++;
    }
    else {
      status.counters.failed++;
      status.fish.lastError = String(sent.error ?? 'UNKNOWN');
    }
  }
  const reader = components.reader ?? createReader({ baseUrl: config.reader.baseUrl, token: config.reader.token });
  const hook = components.hook ?? createHook({ baseUrl: config.hook.baseUrl, token: config.hook.token });
  const sender = components.sender ?? createSender({
    reader,
    hook,
    pollMs: config.sender?.pollMs ?? 400,
    receiptTimeoutMs: config.sender?.receiptTimeoutMs ?? 18000,
    conversationId,
  });
  const fish = components.fish ?? createFish({ baseUrl: config.fish.baseUrl, token: config.fish.token, timeoutMs: config.fish.timeoutMs ?? 30000 });
  const picker = components.picker ?? createStickerPicker({ dir: config.stickers?.dir ?? '' });
  const autoLabelEnabled = Boolean(config.fish?.baseUrl && config.fish?.token) && config.stickers?.autoLabel !== false;
  const autoLabel = components.autoLabel ?? (autoLabelEnabled ? createAutoLabeler({
    baseUrl: config.fish.baseUrl,
    token: config.fish.token,
    outgoingDir: paths.outgoingDir,
    packsDir: config.memes?.packsDir,
    labelsFile: path.join(os.homedir(), '.dsh-fish', 'wechat', 'sticker-labels.json'),
    intervalMs: Number(config.stickers?.autoLabelIntervalMs) || 60 * 60 * 1000,
    batch: Number(config.stickers?.autoLabelBatch) || 15,
    log,
    isBusy: () => inFlight.size > 0 || inFlightBatch,
  }) : { start() {}, stop() {}, runOnce: async () => ({ ok: true, labelled: 0, skipped: true }) });
  const dedupe = components.dedupe ?? createDedupe({ ttlMs: 30 * 60 * 1000 });
  const pacing = components.pacing ?? createPacing({
    baseMs: config.pacing?.baseMs ?? 10000,
    jitter: config.pacing?.jitter ?? [0.6, 3.0],
    maxPerMinute: config.pacing?.maxPerMinute ?? 10,
  });
  const batcher = components.batcher ?? createBatcher({
    silenceMs: config.batch?.silenceMs ?? 8000,
    groupSilenceMs: config.batch?.groupSilenceMs ?? null,
    maxRows: config.batch?.maxRows ?? 40,
  });

  const allowed = new Set((config.whitelist ?? []).map(String));

  // 允许名单热更新：控制台改完配置不用重启桥接，这里每 3 秒比对文件 mtime 并重建名单
  const configPath = config.__configPath || null;
  let configMtime = 0;
  function reloadWhitelistIfChanged() {
    if (!configPath) return false;
    try {
      const stat = fs.statSync(configPath);
      if (stat.mtimeMs === configMtime) return false;
      configMtime = stat.mtimeMs;
      const fresh = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
      const next = new Set((fresh.whitelist ?? []).map(String));
      const before = allowed.size;
      allowed.clear();
      for (const key of next) allowed.add(key);
      if (before !== allowed.size) log(`[whitelist] 已热更新：${before} → ${allowed.size} 个会话`);
      return true;
    } catch { return false; }
  }
  if (configPath) {
    try { configMtime = fs.statSync(configPath).mtimeMs; } catch { /* 文件不在就先等着 */ }
    const watcher = setInterval(reloadWhitelistIfChanged, 3000);
    if (typeof watcher.unref === 'function') watcher.unref();
  }
  // 在途批处理：停机时要等它们跑完，否则重启会吞掉正在发送的回复
  const inFlight = new Set();
  // 最近一条入站消息的时间，用来判断重连之后漏了什么
  let lastEventAtMs = 0;
  // 不在白名单的批次：每个会话 10 分钟内只提示一次
  const skipLoggedAt = new Map();

  async function catchUp(reason) {
    if (!allowed.size) return;
    try {
      const data = await reader.sessions();
      const sessions = Array.isArray(data) ? data : data?.sessions;
      if (!Array.isArray(sessions)) return;
      for (const key of allowed) {
        const parts = splitKey(key);
        if (!parts) continue;
        const hit = sessions.find((row) => row && typeof row.username === 'string' &&
          (row.username.includes('@chatroom') ? 'group' : 'private') === parts.kind &&
          String(conversationId(row.username, row.displayName, row.conversationId)) === parts.target);
        if (!hit) continue;
        const res = await reader.messages(hit.username, 20);
        const rows = Array.isArray(res) ? res : res?.messages;
        if (!Array.isArray(rows)) continue;
        const missed = rows
          .filter((row) => row && row.isSend !== 1 && row.isSend !== true)
          .filter((row) => { const ms = Number(row.createTime) * 1000; return Number.isFinite(ms) && ms > lastEventAtMs; })
          .slice(-10);
        const batchRows = [];
        for (const row of missed) {
          const id = 'catchup:' + String(row.serverId ?? row.localId ?? '');
          if (dedupe.seen(id)) continue;
          const text = String(row.parsedContent ?? row.content ?? '').trim();
          const isImage = Number(row.localType) === 3;
          if (!text && !isImage) continue;
          dedupe.remember(id);
          batchRows.push({
            id,
            sender: String(row.senderUsername ?? ''),
            senderName: String(row.senderDisplay ?? row.senderUsername ?? '群友'),
            text,
            at: Number(row.createTime) * 1000,
            image: isImage,
            imageId: String(row.image?.id ?? ''),
            mentionMe: false,
            pat: false,
          });
        }
        if (!batchRows.length) continue;
        lastEventAtMs = Math.max(lastEventAtMs, ...batchRows.map((row) => row.at));
        log('[catchup] ' + reason + ' 补 ' + batchRows.length + ' 条 -> ' + key);
        track(handleBatch({ key, name: String(hit.displayName ?? ''), kind: parts.kind, rows: batchRows }));
      }
    } catch (error) {
      log('[catchup] 跳过: ' + (error?.message ?? error));
    }
  }

  function track(promise) {
    const p = Promise.resolve(promise).finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  }
  let running = false;
  let timer = null;
  let reconnectTimer = null;
  let cancelReconnect = null;
  // handleBatch 内部兜底：它经常被 void 调用，抛出去就是 unhandledRejection → 进程退出。
  async function handleBatch(batch) {
    try {
      return await handleBatchInner(batch);
    } catch (error) {
      status.counters.failed++;
      status.fish.lastError = String(error?.message ?? error).slice(0, 120);
      log('[batch] 处理失败（已兜底，进程继续）: ' + (error?.message ?? error));
    }
  }

  let inFlightBatch = false;
  async function handleBatchInner(batch) {
    inFlightBatch = true;
    try { return await handleBatchInnerBody(batch); } finally { inFlightBatch = false; }
  }

  async function handleBatchInnerBody(batch) {
    // 只有整批都是指令时才吞掉整批；混合批里其他人的正常问题不能被顺手丢掉
    if (splitKey(batch.key)?.kind === 'group' && admin.process(batch.rows) && (batch.rows?.length ?? 0) === 1) return;
    if (admin.snapshot().muted) {
      const count = batch.rows?.length ?? 0;
      status.counters.silents += count;
      log(`[muted] 跳过 ${count} 条`);
      return;
    }
    if (!allowed.has(batch.key)) {
      // 以前这里是静默 return：白名单掉了之后日志一片安静，排查时像"根本没收到消息"。
      // 每个会话最多 10 分钟提示一次，避免把日志刷满。
      const now = Date.now();
      if (!skipLoggedAt.has(batch.key) || now - skipLoggedAt.get(batch.key) > 10 * 60 * 1000) {
        skipLoggedAt.set(batch.key, now);
        log(`[skip] ${batch.key} 不在白名单，本批 ${batch.rows?.length ?? 0} 条丢掉（同类提示 10 分钟内不重复）`);
      }
      return;
    }
    const parts = splitKey(batch.key);
    if (!parts) return;

    const result = await fish.turn(batch);
    if (result.kind === 'reply') {
      status.fish.connected = true;
      status.fish.lastReplyAt = Date.now();
      status.counters.replies++;
    } else if (result.kind === 'silent') status.counters.silents++;
    log('[fish] 结果 ' + result.kind + (result.reason ? ' reason=' + result.reason : '') + (result.error ? ' err=' + result.error : '') + (result.text ? ' : ' + result.text.slice(0, 60) : '') + (result.kind === 'silent' ? ' | 本批 ' + (batch.rows?.length ?? 0) + ' 条' : ''));

    // 只认独占一行的控制标记；普通正文里的「[表情]」不改动。
    const markerLine = /^[^\S\r\n]*(?:\[表情\]|［表情］|【表情】)[^\S\r\n]*$/;
    const lines = result.kind === 'reply' ? String(result.text ?? '').split(/\r?\n/) : [];
    const hasMarker = lines.some((line) => markerLine.test(line));
    // 兜底：本批有人明确要表情时，她嘴硬不发也得发一张
    const wantsSticker = (batch.rows ?? []).some((row) => /(发|来|给|整).{0,6}(表情|图)|表情包/.test(String(row?.text ?? '')));
    const replyText = hasMarker ? lines.filter((line) => !markerLine.test(line)).join('\n').trim() : result.text;
    // 每次 sender 调用都等待回执：伴随文字先发完，再走现有选图/微信池回落。
    if (result.kind === 'reply' && (!hasMarker || replyText)) {
      await pacing.wait('reply');
      const sent = await sender.sendText({ kind: parts.kind, target: parts.target, text: replyText });
      recordSend(sent);
      if (sent.ok) log(`[send] ok -> ${batch.key} ${sent.messageId ?? ''} : ${replyText.slice(0, 40)}`);
      else log(`[send] failed ${sent.error} -> ${batch.key}`);
    }

    // 原生 sticker 不解析伴随文字，也不重复发送。
    if (result.kind === 'sticker' || result.stickerFile || hasMarker || (result.kind === 'reply' && wantsSticker && result.reason !== 'draw-failed')) {
      const memes = { ...DEFAULT_MEMES, ...config.memes };
      const outgoingDir = paths.outgoingDir;
      let pick = null;
      if (result.stickerFile && fs.existsSync(result.stickerFile)) {
        try {
          pick = importToOutgoing({ file: result.stickerFile, outgoingDir, pythonPath: memes.pythonPath });
          log('[draw] 使用生成图 ' + result.stickerFile);
        } catch (error) {
          log('[draw] 失败: ' + String(error?.message ?? error));
          return; // 有生成文件但校验失败：不要拿随机图冒充生成结果
        }
      }
      if (!pick && memes.enabled) {
        try {
          const emotion = result.emotion ?? result.meta?.emotion;
          const local = listLocalMemes(memes.packsDir);
          let file = null;
          if (emotion && !local.some((item) => item.emotion === emotion) && memes.remoteManifests?.length) {
            let remaining = Math.max(0, Math.floor(Number(memes.webFillLimit) || 0));
            for (const [index, manifestUrl] of memes.remoteManifests.entries()) {
              if (!remaining || file) break;
              const budget = Math.ceil(remaining / (memes.remoteManifests.length - index));
              const files = await fetchRemote({ manifestUrl, emotion, limit: budget,
                fetchImpl: components.fetchImpl ?? globalThis.fetch,
                cacheDir: path.join(tmpdir(), 'wechat-fish-bridge-memes') });
              // 总请求预算而非成功数，避免多个清单放大每次补图量。
              remaining -= budget;
              if (files.length) {
                file = files[Math.floor(Math.random() * files.length)];
                log('[meme] 联网补图 ' + emotion + ' ' + files.length + ' 张');
              } else log('[meme] 联网补图为空或失败');
            }
          }
          if (!file) {
            // 有标签就按标签挑（情绪匹配 + 跳过星期几对不上的），没有标签再退回随机
            try {
              const labelsFile = path.join(os.homedir(), '.dsh-fish', 'wechat', 'sticker-labels.json');
              const labels = loadLabels(labelsFile);
              const local = listLocalMemes(memes.packsDir);
              const byEmotion = emotion ? local.filter((item) => item.emotion === emotion) : [];
              const chosen = pickByLabel(byEmotion.length ? byEmotion : local, labels, emotion);
              if (chosen) file = chosen.file;
            } catch { /* 标签坏了就退回随机 */ }
            if (!file) file = pickMeme({ packsDir: memes.packsDir, emotion })?.file;
            if (file) log('[meme] 本地图 ' + file);
          }
          if (file) pick = importToOutgoing({ file, outgoingDir, pythonPath: memes.pythonPath });
        } catch (error) { log('[meme] 图库失败 ' + String(error?.message ?? error)); }
      }
      if (!pick) {
        if (memes.enabled) log('[meme] 回落微信表情池');
        const fallback = picker.pick();
        // 关闭扩展时维持原有微信池行为；池文件已经是原生 md5 格式。
        if (fallback && !memes.enabled) pick = fallback;
        else if (fallback) {
          try { pick = importToOutgoing({ file: fallback.path, outgoingDir, pythonPath: memes.pythonPath }); }
          catch (error) { log('[meme] 微信表情导入失败 ' + String(error?.message ?? error)); }
        }
      }
      if (!pick) { log('[meme] 图库与微信表情池均无可发送图片，跳过'); return; }
      await pacing.wait('sticker');
      let sent;
      try {
        sent = await sender.sendSticker({ kind: parts.kind, target: parts.target, sticker: pick });
      } catch (error) {
        sent = { ok: false, error: String(error?.message ?? error) };
      }
      recordSend(sent, true);
      if (sent.ok) log('[sticker] ok -> ' + batch.key + ' ' + (sent.messageId ?? '') + ' ' + pick.md5.slice(0, 8));
      else log('[sticker] failed ' + sent.error + (sent.detail ? ' ' + sent.detail : '') + ' -> ' + batch.key);
      return;
    }

  }

  function flushPending() {
    const batch = batcher.flushNow();
    if (batch) track(handleBatch(batch));
  }

  async function pump() {
    while (running) {
      let event;
      try {
        event = await reader.push();
      } catch (error) {
        if (!running) break;
        status.reader.connected = false;
        status.reader.reconnects++;
        log(`[reader] ${String(error?.message ?? error)}，2s 后重连`);
        void catchUp('重连');
        await new Promise((resolve) => {
          cancelReconnect = resolve;
          reconnectTimer = setTimeout(resolve, 2000);
        });
        reconnectTimer = null;
        cancelReconnect = null;
        continue;
      }
      if (!running) break;
      status.reader.connected = true;
      status.reader.lastEventAt = Date.now();
      status.counters.events++;
      if (event?.timestamp) lastEventAtMs = Math.max(lastEventAtMs, Number(event.timestamp) * 1000);
      if (config.debug) log('[event] ' + JSON.stringify(event).slice(0, 400));
      const normalized = normalizeEvent(event, config.ownWxid ?? '', config.mentionAliases);
  if (normalized?.image || normalized?.imageId) log('[image] id=' + (normalized.imageId || '(无)') + ' image=' + Boolean(normalized.image) + ' key=' + normalized.key);
      if (!normalized) { log('[event] 丢弃（无法归一化）'); continue; }
      if (normalized.id && dedupe.seen(normalized.id)) continue;
      if (normalized.id) dedupe.remember(normalized.id);
      const outcome = batcher.push(normalized);
  // 先交出 push() 已经形成的整批（它可能是另一个会话的），再处理紧急出批；
  // 反过来会把这批丢掉（审查发现的 P0）。
  if (outcome?.flush && outcome.batch) track(handleBatch(outcome.batch));
  // 被 @ 或拍一拍：不等攒批静默，立刻出批
  if (normalized && (normalized.mentionMe || normalized.pat)) {
    const urgent = batcher.flushNow();
    if (urgent) track(handleBatch(urgent)); // 不能 return，会把整个 SSE 循环退出
  }
    }
  }

  return {
    start() {
      if (running) return;
      // 启动补偿只覆盖最近 2 分钟：重启期间漏掉的消息不会太旧，也不会把历史全回一遍
      if (!lastEventAtMs) lastEventAtMs = Date.now() - 120_000;
      statusServer = (components.http ?? http).createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/status') {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
      });
      statusServer.on('error', (error) => log('[status] ' + String(error?.message ?? error)));
      // 单实例：状态端口被占用说明已经有桥接在跑，直接退出，避免两个实例同时回消息
  statusServer.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log('[bridge] 已有实例在运行，本进程退出');
      process.exit(0);
    }
    log('[bridge] status server 错误: ' + (e && e.message));
  });
  statusServer.listen(config.statusPort ?? 11232, '127.0.0.1');
      running = true;
      void (async () => {
        try {
          await hook.health();
          status.hook.account = String(await hook.account());
          status.hook.ok = true;
        } catch {
          status.hook.ok = false;
        }
      })();
      timer = setInterval(() => {
        const batch = batcher.tick(Date.now());
        if (batch) track(handleBatch(batch));
      }, 1000);
      void pump();
      log('[bridge] started');
      // 启动时把允许名单打出来：白名单被清掉时，一眼能看出来
      log('[whitelist] ' + (allowed.size ? [...allowed].join(', ') : '（空，谁都不回）'));
      if (config.stickers?.autoLabel !== false) autoLabel.start();
      void catchUp('启动');
    },
    async stop() {
      running = false;
      autoLabel.stop();
      if (timer) clearInterval(timer);
      timer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cancelReconnect?.();
      reconnectTimer = null;
      cancelReconnect = null;
      status.reader.connected = false;
      flushPending();
      // 等最多 8 秒让在途的批（含发送与回执）跑完
      if (inFlight.size) {
        log('[bridge] 等待 ' + inFlight.size + ' 个在途批次完成');
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise((resolve) => setTimeout(resolve, 8000)),
        ]);
      }
      const server = statusServer;
      statusServer = null;
      if (server) await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
    // 测试用
    _internals: { batcher, dedupe, pacing, sender, fish, normalizeEvent, handleBatch, status, autoLabel },
  };
}
