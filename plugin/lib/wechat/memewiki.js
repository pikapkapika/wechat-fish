/**
 * memewiki.js —— 梗百科（本地 6668 条，离线）
 *
 * 数据来自 WeChatAgent 的 memewiki 插件（移植自 in1t1a1/astrbot_plugin_memewiki），
 * 拷到 ~/.dsh-fish/wechat/memewiki.json.gz。她的微信回合没有工具可调，
 * 所以这里做成"命中就注入资料"：群友问某个梗时，把词条塞进提示词，
 * 让她**先接梗，别科普**。
 *
 * 词条结构：{ t: 词条, g: 分类/标签, u: 怎么用, o: 出处 }
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FILE = 'memewiki.json.gz';
const CACHE_TTL_MS = 10 * 60 * 1000;

const caches = new Map(); // root -> { at, map }

function fileOf(root) {
  return path.join(root, 'wechat', FILE);
}

export function loadWiki(root) {
  const now = Date.now();
  const cached = caches.get(root);
  if (cached && cached.map && now - cached.at < CACHE_TTL_MS) return cached.map;
  const file = fileOf(root);
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const list = JSON.parse(raw);
    const map = new Map();
    if (Array.isArray(list)) {
      for (const item of list) {
        const term = String(item?.t ?? '').trim();
        if (term) map.set(term.toLowerCase(), item);
      }
    }
    caches.set(root, { at: now, map });
    return map;
  } catch {
    const empty = new Map();
    caches.set(root, { at: now, map: empty });
    return empty;
  }
}

/** 精确命中优先，其次前缀/包含；返回 [{ t, g, u }]。 */
export function searchWiki(root, term, limit = 2) {
  const key = String(term ?? '').trim().toLowerCase();
  if (!key) return [];
  const map = loadWiki(root);
  const exact = map.get(key);
  const hits = [];
  if (exact) hits.push(exact);
  if (hits.length < limit) {
    for (const [k, item] of map) {
      if (k === key) continue;
      if (k.includes(key) || key.includes(k)) {
        hits.push(item);
        if (hits.length >= limit) break;
      }
    }
  }
  return hits.map((item) => ({
    t: String(item?.t ?? ''),
    g: String(item?.g ?? ''),
    // 只留一句「怎么用」：塞整段定义她就会照念
    u: String(item?.u ?? '').replace(/\s+/g, ' ').slice(0, 90),
  }));
}

const QUERY_PATTERNS = [
  /「([^」]{1,20})」/,
  /([A-Za-z0-9_\-]{2,20})\s*(?:是什么意思|什么意思|是什么梗|什么梗|是啥|啥梗)/,
  /([\u4e00-\u9fa5A-Za-z0-9_\-]{2,20})\s*(?:是什么意思|什么意思|是什么梗|什么梗|是啥意思|啥意思)/,
  /([\u4e00-\u9fa5A-Za-z0-9_\-]{2,20})\s*(?:的梗|这个梗)/,
];

/** 从一批消息里挑出"像是在问梗"的词，最多 2 个。 */
export function extractTerms(rows, limit = 2) {
  const out = [];
  for (const row of rows ?? []) {
    const text = String(row?.text ?? '').trim();
    if (!text) continue;
    for (const pattern of QUERY_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const term = String(match[1] ?? '').trim();
      if (term && !out.includes(term)) out.push(term);
      break;
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 命中时返回要注入提示词的一段；没命中返回 ''。 */
export function memeBrief(root, rows, limit = 2) {
  const terms = extractTerms(rows, limit);
  if (!terms.length) return '';
  const lines = [];
  for (const term of terms) {
    const hits = searchWiki(root, term, 1);
    if (!hits.length) continue;
    const item = hits[0];
    lines.push('- 「' + item.t + '」' + (item.g ? '（' + item.g + '）' : '') + '：' + item.u);
  }
  if (!lines.length) return '';
  return [
    '〔梗百科〕群友在问这些东西，你要**直接接梗**（用对或者损一句都行），不要科普、不要念定义：',
    ...lines,
  ].join('\n');
}
