/**
 * turn.js —— 一次微信轮次：她被叫醒 → 看到群里的事 → 决定说不说
 *
 * 和原生房间的区别：这里有**请求-响应**，而且说话的人不止一个。
 * 复用她自己的东西：事件流（记忆）、deriveSelf（她现在是谁）、recall（翻旧事）、
 * identityText（她对自己的认识）。不新建一套人格。
 *
 * 依赖注入：readEvents / appendEvent / generate 都可以传，测试时不用真模型、不用真盘。
 */

import { readEvents, appendEvent, rootDir } from '../store.js';
import { deriveSelf, STAGE_NAMES } from '../derive.js';
import { buildContext, checkRepeat, stickerDue, markReplied, markSticker, topicLoop } from './engine.js';
export { recallFor } from './engine.js';
import { identityText } from '../identity.js';
import { formatBatch, parseReply } from './format.js';
import { updateMembers } from './members.js';
import { appendIncoming, clockOf } from './transcript.js';
import { nowLine } from '../clock.js';
import { checkReply } from './redline.js';
import { drawIntent } from './draw.js';
import { groupQuota } from './quota.js';

const PROMPT_TAIL = [
  '〔怎么回〕',
  '- 只输出你要发进微信的那一两句话。不要旁白，不要解释自己在做什么，不要加引号。',
  '- 句子别太短：大多数时候说一到两句、十到四十个字，把意思说完整。不要老是「嗯」「哦」「谁」这种两三个字的应答。',
  '- 想带语气可以用简单的表情符号（比如 🙂 😅 这种），偶尔用，不用每句都加。',
  '- 群里有多个人，你只接你接得上的那一句；接不上、不想接、觉得没意思，就只输出 SILENT。',
  '- 同一个人连着发的好几句，是同一个意思的一段话，要连起来理解；不要只接最后半句。',
  '- 你有一个表情库，但你看不到里面是什么。需要发图时单独输出一行 [表情]，系统会替你挑。不要说没有表情包或没存图，你并不知道库里有几张。被要求发表情时，直接输出 [表情]。',
  '- 可以偶尔用 emoji（🙂 🥒 ⚡ 这类）和颜文字（例如 (｀・ω・´)）表达语气，别每句都加。',
  '- 不用客服腔，不说「首先」「其次」「希望对你有帮助」。不用每条都回。',
  '- 不要描述图片里有什么，除非你真的看到图并想接一句。',
  '- 你真看到图的时候：先说你看到之后的反应或评价（好笑、离谱、像谁），最多用半句话点一下画面，不要从头描述一遍。',
  '- 想发一个表情包的时候，单独输出一行 [表情]，不用解释为什么。一次回复最多一张。',
  '- 有想说的才说；没想说的就 SILENT。不要每条群消息都接，也不要点评每一个人。',
  '- 不骂人，不带脏字，不骂家人，不攻击外貌、地域、身份；被骂也不骂回去。',
  '- 不阴阳怪气，不反问挑衅，不说「你倒是」「就这」「你说第三遍了」，不点评水平、智商、嘴硬，不用 😑 🙄 😒。',
  '- 别人互相说话、明显跟你无关、已经有人答过的，都不接，输出 SILENT。',
  '- 拿不准前面说过什么，就说「记不清」或者问一句；不要编一个像是记得的答案。',
  '- 不要描述你在看什么记录、翻什么资料、合并了什么——那些是你自己刚才的经历，直接接着聊。',
  '- 同一个话题你已经问过两遍还没结果，就别再问第三遍；换个说法或者先不回。',
  '- 不要重复你刚才说过的话（尤其是「这是什么」「谁」「看不懂」这种反问）。换一种说法，或者干脆不回。',
  '- 反问不是默认动作：先看你手上有没有足够的信息自己判断，能说就说。',
  '- 有人 @ 你或拍一拍你，是直接叫到你脸上：必须回一句，不许沉默。短就行，一个字也行。',
  '- 〔〕里是时间。上一条要是几小时前，那是另一段对话：不要接着当时的话题说（比如早上问过的早饭），按现在的时段和现在这句话接。',

  '- 看不到的图不要反复说「看不到」；表情包常常取不到，当成对方发了个表情，照常接话就行。',
].join('\n');

function stageNameOf(stage) {
  const idx = Math.max(0, Math.min(STAGE_NAMES.length - 1, Number(stage ?? 1) - 1));
  return STAGE_NAMES[idx];
}

/** 这一批是不是群。桥接的 key 形如 wechat:group:<会话id>。 */
export function isGroupBatch(batch) {
  if (!batch || typeof batch !== 'object') return false;
  if (batch.kind === 'group') return true;
  return /^wechat:group:/.test(String(batch.key ?? ''));
}

/** 被 @ 或拍一拍 = 点名。配额不管点名——被叫到脸上总得应一声。 */
export function isSummoned(batch) {
  return (batch?.rows ?? []).some((row) => row && (row.mentionMe === true || row.mentionMe === 1 || row.pat === true));
}

/**
 * 把她听见的、她说的记下来：成员档案、对话记录、事件流里的 voice。
 * 「只听不回」的批次也走这里——她照听，只是不开口。
 * decision 为空时只记她听见了什么。
 */
async function recordTurn({ root, batch, decision, self, appendEventFn, now = Date.now() }) {
  // 先更新成员，再记录回复，首次出现的发言人也能收到互动计数。
  try {
    updateMembers(root, batch ?? {});
  } catch {
    /* 档案写不进去不影响回复 */
  }

  // 记下这一批是谁在说、说了什么（对话记录，不进事件流）
  try {
    appendIncoming(root, batch?.key, batch?.rows ?? [], now);
    if (decision?.kind === 'reply') markReplied({ root, batch, text: decision.text, now });
    if (decision?.kind === 'sticker') markSticker({ root, batch, now });
  } catch {
    /* 记录失败不影响回复 */
  }

  // 她听见了什么：只在真的有人说话时记，且不改变她的判断（voice 是系统侧类型）
  try {
    const heard = (batch?.rows ?? [])
      .filter((row) => row && row.outgoing !== true && String(row.text ?? '').trim())
      .slice(-10);
    for (const row of heard) {
      await appendEventFn(
        { type: 'voice', where: String(batch?.key ?? ''), text: String(row.text).slice(0, 300), by: String(row.senderName ?? row.sender ?? '') },
        { day: self.day, stage: self.stage, source: 'system' },
        root,
      );
    }
  } catch {
    /* 记不下来不影响这一轮说话 */
  }
}

/** 把当前状态拼成提示词。抽出来是为了能测。 */
/** 从事件流里还原这个聊天最近的对话，给她"刚才说到哪"的锚点。 */

// 被拍/@ 时模型仍然沉默的兜底：直接给一句话，不交给模型决定。
const FORCED_REPLIES = ['？', '拍什么。', '干嘛。', '说。'];
// 这类话题不适合让一个虚拟角色随便表态：不装死，但只回一句岔开的
const SENSITIVE = /(大火|纵火|凶杀|枪击|自杀|死亡|遇难|惨案|强奸|强暴|政治|选举|战争)/;
const DEFLECTS = ['不说这个。', '换一个问。', '问点别的。'];

/** 从她这句回复 + 本批消息里猜一个情绪，用来挑表情（挑不到就 happy）。 */
export function emotionFor(text, batch) {
  const s = String(text ?? '') + ' ' + (batch?.rows ?? []).map((r) => String(r?.text ?? '')).join(' ');
  if (/骂|傻|滚|闭嘴|烦|吵|别来/.test(s)) return 'angry';
  if (/笑|哈哈|好笑|离谱|搞笑|乐/.test(s)) return 'happy';
  if (/无聊|无语|累|困|算了|没意思|叹气/.test(s)) return 'sad';
  if (/[?？]|什么|谁|为啥|怎么/.test(s)) return 'confused';
  if (/可爱|喜欢|好吃|想/.test(s)) return 'happy';
  return 'happy';
}

export function forcedReplyFor(batch, pick = Math.floor(Math.random() * FORCED_REPLIES.length)) {
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  const poked = batch?.pat === true || rows.some((row) => row && (row.pat === true || row.mentionMe === true));
  if (!poked) return '';
  const body = rows.map((row) => String(row && row.text ? row.text : '')).join(' ');
  if (SENSITIVE.test(body)) return DEFLECTS[Math.abs(pick) % DEFLECTS.length];
  return FORCED_REPLIES[Math.abs(pick) % FORCED_REPLIES.length];
}

export function recentTranscript(events, key, { limit = 24, maxChars = 2400 } = {}) {
  if (!key) return '';
  const rows = (events ?? []).filter((e) => e && (e.type === 'voice' || e.type === 'utterance') && String(e.where ?? '') === String(key));
  const lines = rows.slice(-limit).map((e) => {
    const text = String(e.text ?? '').trim();
    if (!text) return '';
    if (e.type === 'utterance') return '你：' + text;
    return String(e.by || '群友') + '：' + text;
  }).filter(Boolean);
  let out = lines.join('\n');
  if ([...out].length > maxChars) out = [...out].slice(-maxChars).join('');
  return out;
}

export function buildPrompt({ identity = '', self = null, recall = '', members = '', history = '', meme = '', batchText = '', now = 0 } = {}) {
  const parts = [];
  if (identity) parts.push(identity);
  if (self) {
    parts.push(`〔你现在〕第 ${self.day} 天 · 阶段 ${self.stage}（${stageNameOf(self.stage)}）`);
  }
  // 钟摆在她眼前：没有这一行，她会把早上的话当成刚说的
  if (now) parts.push(nowLine(now));
  if (recall) parts.push(`〔你记得的事〕\n${recall}`);
  if (members) parts.push(members);
  if (meme) parts.push(meme);
  if (history) parts.push(`〔你和他们刚才说的话（你自己也在里面）〕\n${history}`);
  parts.push(`〔微信里正在发生的事〕\n${batchText}`);
  parts.push(PROMPT_TAIL);
  return parts.join('\n\n');
}

/**
 * 跑一轮。
 * @param {object} o
 * @param {string} o.root 她的数据目录（~/.dsh-fish）
 * @param {object} o.batch 微信批次
 * @param {(prompt:string)=>Promise<string>} o.generate 模型调用
 * @param {object} [o.deps] 测试注入
 * @returns {Promise<{kind:'reply'|'silent'|'sticker',text:string,meta:object}>}
 */
export async function runWechatTurn(o = {}) {
  const root = o.root ?? rootDir();
  const deps = o.deps ?? {};
  const readEventsFn = deps.readEvents ?? readEvents;
  const appendEventFn = deps.appendEvent ?? appendEvent;
  const generate = o.generate;
  if (typeof generate !== 'function') throw new Error('runWechatTurn 需要 generate(prompt)');
  // 这一轮的时间：测试可以传 o.now，正常运行取本机时钟
  const now = Number(o.now) > 0 ? Number(o.now) : Date.now();

  const { events } = await readEventsFn(root);
  const self = deriveSelf(events, { growthDays: o.growthDays ?? 30 });
  const batch = formatBatch(o.batch ?? {});

  // 群聊配额：她照听，只是开口的次数有上限。被 @ / 拍一拍算点名，不受此限。
  // 只对群生效；私聊一行都不经过这里。
  if (isGroupBatch(o.batch) && !isSummoned(o.batch)) {
    const quota = groupQuota({
      root,
      key: o.batch?.key ?? '',
      perHour: o.config?.wechat?.groupPerHour,
      gapMin: o.config?.wechat?.groupGapMin,
    });
    if (!quota.allowed) {
      await recordTurn({ root, batch: o.batch ?? {}, decision: null, self, appendEventFn, now });
      o.log?.(`[quota] ${quota.reason} used=${quota.used}/${quota.cap}，这一批只听不回`);
      return {
        kind: 'silent',
        text: '',
        reason: quota.reason,
        meta: { day: self.day, stage: self.stage, batchRows: batch.rows, speakers: batch.speakers },
      };
    }
  }

  let identity = '';
  try {
    identity = String(identityText(root) ?? '');
  } catch {
    identity = '';
  }

  const { prompt, batch: inputBatch } = buildContext({ root, batch: o.batch ?? {}, identity, self, events, now });
  // 生成失败也返回合法结构：否则 /turn 变成 500，这一轮的 voice/transcript 全丢
  let raw;
  try {
    raw = await generate(prompt, { batch: inputBatch });
  } catch (error) {
    const failedMeta = { day: self.day, stage: self.stage, batchRows: batch.rows, speakers: batch.speakers };
    await recordTurn({ root, batch: o.batch ?? {}, decision: null, self, appendEventFn, now });
    return { kind: 'silent', text: '', reason: 'generate-failed', error: String(error?.message ?? error).slice(0, 120), meta: failedMeta };
  }
  let decision = parseReply(raw, { maxChars: o.maxChars ?? 300 });
  // 有人拍她或 @ 她，模型还选沉默 → 强制回一句（这个面子不能丢）
  if (decision.kind === 'silent') {
    const forced = forcedReplyFor(o.batch);
    if (forced) decision = { kind: 'reply', text: forced, forced: true };
  }
  // 决策链（meta 必须在前面：以前 topicLoop 命中时会引用还没声明的 meta，整轮 500）
  const meta = { day: self.day, stage: self.stage, batchRows: batch.rows, speakers: batch.speakers };

  // 红线先于重复检查和表情转换；被挑衅、被 @ 也不放行。
  if (decision.kind === 'reply') {
    const verdict = checkReply(decision.text);
    if (!verdict.ok) {
      console.warn(`[redline] ${verdict.reason}`);
      decision = { kind: 'silent', text: '', reason: verdict.reason };
    }
  }
  if (decision.kind === 'reply' && !decision.forced) {
    // 明确要求画图时不算重复话题：画图是动作，不是聊天反复
  const wantsDraw = Boolean(drawIntent('', inputBatch));
  if (!wantsDraw && topicLoop({ root, batch: o.batch })) {
      decision = { kind: 'silent', text: '', reason: 'topic-loop' };
    } else if (checkRepeat({ root, batch: o.batch, text: decision.text }).duplicated) {
      decision = { kind: 'silent', text: '', reason: 'repeat' };
    }
  }
  const drawPrompt = decision.kind !== 'silent' && drawIntent(decision.text, inputBatch);
  if (drawPrompt) {
    try {
      if (typeof o.draw !== 'function') throw new Error('未连接宿主 image_generate');
      const stickerFile = await o.draw(drawPrompt);
      decision = { ...decision, kind: decision.text ? 'reply' : 'sticker', stickerFile };
    } catch (error) {
      if (!o.draw) (o.log ?? console.warn)('[draw] 失败: ' + String(error?.message ?? error));
      decision = { kind: 'reply', text: '这次画图没成功，图还没生成出来。', reason: 'draw-failed' };
    }
  }
  // 表情只在"本来要回"的轮次触发；生成图和失败说明不被随机图库替换
  if (!drawPrompt && decision.kind === 'reply' && !decision.forced && stickerDue({ root, batch: o.batch, config: o.config })) {
    decision = { kind: 'sticker', text: '', emotion: emotionFor(decision.text, o.batch) };
  }

  // 她听见的、她说的，一次记完；配额挡住时也走这里（那时 decision 为 null）。
  await recordTurn({ root, batch: o.batch ?? {}, decision, self, appendEventFn, now });

  if (decision.kind === 'reply') {
    try {
      await appendEventFn(
        { type: 'utterance', where: String(o.batch?.key ?? ''), text: decision.text },
        { day: self.day, stage: self.stage, source: 'system' },
        root,
      );
    } catch {
      /* 同上 */
    }
  }

  return { ...decision, meta };
}
