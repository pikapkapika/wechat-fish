/**
 * members.js —— 群友档案（2026-10-27）
 *
 * 她要"记住每个群友的特点"，但她的记忆是**事件流**（自己的判断），
 * 不是通讯录。所以这份档案单独存放、单独更新，只作为**每轮提示词里的参考资料**，
 * 不写进 events.jsonl——否则谁说了什么都会变成"她的判断"。
 *
 * 记什么（克制版）：
 *   - 名字、说话次数、第一次/最后一次出现
 *   - 最近说过的话（最多 5 条，每条 60 字）
 *   - 简单标签：话多/爱发图/刚认识
 *
 * 为什么不记"性格"：性格要靠她自己判断（growth_commit），
 * 这里只给事实，不给结论。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const MAX_MEMBERS = 200;
const MAX_SAMPLES = 8;
const SAMPLE_CHARS = 80;

function fileOf(root) {
  return path.join(root, 'wechat', 'members.json');
}

export function loadMembers(root) {
  const file = fileOf(root);
  if (!existsSync(file)) return { version: 1, chats: {} };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || !data.chats || typeof data.chats !== 'object') return { version: 1, chats: {} };
    for (const chat of Object.values(data.chats)) {
      if (!chat || typeof chat !== 'object') continue;
      chat.members ??= {};
      for (const [id, member] of Object.entries(chat.members)) chat.members[id] = normalizeMember(member, id);
    }
    return data;
  } catch {
    return { version: 1, chats: {} };
  }
}

export function saveMembers(root, data) {
  const file = fileOf(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// sender 是现有桥接层提供的唯一 ID；显示名只用于 name。
function idOf(row) {
  return String(row?.talkerId ?? row?.sender ?? '').trim();
}

function normalizeMember(value, id = '') {
  const member = value && typeof value === 'object' ? value : {};
  const number = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
  member.name = String(member.name ?? id);
  for (const key of ['count', 'images', 'stickers', 'firstAt', 'lastAt']) member[key] = number(member[key]);
  member.samples = Array.isArray(member.samples) ? member.samples.slice(-MAX_SAMPLES) : [];
  member.role = ['owner', 'admin', 'member', 'unknown'].includes(member.role) ? member.role : 'unknown';
  const interaction = member.interactions ?? {};
  member.interactions = {
    replied: number(interaction.replied), mentions: number(interaction.mentions), lastReplyAt: number(interaction.lastReplyAt),
  };
  member.note = typeof member.note === 'string' ? member.note : '';
  member.tags = tagsOf(member);
  return member;
}

function tagsOf(member) {
  const tags = [];
  if (member.count >= 50) tags.push('话很多');
  else if (member.count >= 15) tags.push('常说话');
  else if (member.count <= 3) tags.push('刚认识');
  if (member.images >= 3) tags.push('爱发图');
  if (member.stickers >= 3) tags.push('爱发表情');
  if (member.interactions?.replied >= 5) tags.push('常被回');
  if (member.interactions?.mentions >= 3) tags.push('常 @ 你');
  return tags;
}

/**
 * 用一批入站消息更新档案。返回被更新的成员 id 列表。
 */
export function updateMembers(root, batch, now = Date.now()) {
  const key = String(batch?.key ?? '');
  if (!key) return [];
  const rows = (batch?.rows ?? []).filter((row) => row && row.outgoing !== true && idOf(row));
  if (!rows.length) return [];

  const data = loadMembers(root);
  const chat = (data.chats[key] ??= { name: String(batch?.name ?? ''), members: {} });
  chat.name = String(batch?.name ?? chat.name ?? '');

  const touched = new Set();
  for (const row of rows) {
    const id = idOf(row);
    if (!Object.hasOwn(chat.members, id)) {
      Object.defineProperty(chat.members, id, {
        value: normalizeMember({ name: String(row.senderName ?? id), firstAt: now }),
        enumerable: true, writable: true, configurable: true,
      });
    }
    const member = chat.members[id];
    member.name = String(row.senderName ?? member.name ?? id);
    member.count += 1;
    if (row.image) member.images += 1;
    if (row.sticker) member.stickers += 1;
    member.lastAt = now;
    if (row.role != null) member.role = ['owner', 'admin', 'member', 'unknown'].includes(row.role) ? row.role : 'unknown';
    if (row.mentionMe) member.interactions.mentions += 1;
    member.tags = tagsOf(member);
    const text = String(row.text ?? '').trim();
    if (text) {
      member.samples.push(text.slice(0, SAMPLE_CHARS));
      if (member.samples.length > MAX_SAMPLES) member.samples = member.samples.slice(-MAX_SAMPLES);
    }
    touched.add(id);
  }

  // 上限：按最后出现时间淘汰最久没说话的
  const ids = Object.keys(chat.members);
  if (ids.length > MAX_MEMBERS) {
    ids.sort((a, b) => (chat.members[a].lastAt ?? 0) - (chat.members[b].lastAt ?? 0));
    for (const id of ids.slice(0, ids.length - MAX_MEMBERS)) delete chat.members[id];
  }

  saveMembers(root, data);
  return [...touched];
}

/** 每批每位发言人只记一次文字回复，不把同批多条消息算成多次互动。 */
export function recordReplies(root, chatKey, rows, now = Date.now()) {
  const data = loadMembers(root);
  const chat = data.chats[String(chatKey ?? '')];
  if (!chat) return;
  const ids = new Set((rows ?? []).filter((row) => row && row.outgoing !== true).map(idOf).filter(Boolean));
  let changed = false;
  for (const id of ids) {
    if (!Object.hasOwn(chat.members, id)) continue;
    const member = chat.members[id];
    member.interactions.replied += 1;
    member.interactions.lastReplyAt = now;
    member.tags = tagsOf(member);
    changed = true;
  }
  if (changed) saveMembers(root, data);
}

/** 控制台使用的事实摘要，按说话次数降序排列。 */
export function listMembers(root, chatKey) {
  const members = loadMembers(root).chats[String(chatKey ?? '')]?.members ?? {};
  return Object.entries(members).map(([id, member]) => ({
    id, name: member.name, role: member.role, tags: member.tags,
    count: member.count, replied: member.interactions.replied,
    mentions: member.interactions.mentions, lastAt: member.lastAt,
  })).sort((a, b) => b.count - a.count);
}

/** 单个成员的档案行；没有记录返回 ''。 */
export function describeMember(member) {
  if (!member) return '';
  const tags = tagsOf(member);
  const parts = [];
  parts.push(String(member.name || '某人'));
  if (tags.length) parts.push('（' + tags.join('、') + '）');
  parts.push('说过 ' + member.count + ' 次');
  const said = (member.samples ?? []).slice(-3);
  if (said.length) parts.push('最近：' + said.map((s) => '「' + s + '」').join(''));
  return parts.join(' ') ;
}

/**
 * 给这一批的发言人（以及常说话的几个人）生成提示词段落。
 * 只给事实，不给性格判断。
 */
export function describeMembers(root, batch, { limit = 6 } = {}) {
  const key = String(batch?.key ?? '');
  if (!key) return '';
  const data = loadMembers(root);
  const chat = data.chats?.[key];
  if (!chat) return '';

  const senders = new Set((batch?.rows ?? []).filter((r) => r && r.outgoing !== true).map(idOf));
  const all = Object.entries(chat.members ?? {});
  const picked = all
    .sort((a, b) => {
      const inA = senders.has(a[0]) ? 1 : 0;
      const inB = senders.has(b[0]) ? 1 : 0;
      if (inA !== inB) return inB - inA;
      return (b[1].count ?? 0) - (a[1].count ?? 0);
    })
    .slice(0, limit);

  if (!picked.length) return '';
  const lines = picked.map(([, member]) => '- ' + describeMember(member)).filter(Boolean);
  return '〔你认识的群友〕\n' + lines.join('\n') + '\n（这些是你对他们的印象，用来分辨谁是谁；不确定的别装熟。）';
}
