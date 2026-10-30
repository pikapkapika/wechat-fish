/**
 * format.js —— 把微信批次变成她读得懂的一段"正在发生的事"
 *
 * 微信和她的原生房间最大的差别：**说话的不止一个人**。
 * 她原来的世界是一对一（主人 ↔ 她），如果直接把微信群的消息原样塞进去，
 * 她会把三个人说的话当成同一个人说的。所以这里做四件事：
 *
 *   1. 标注发言人（群友「昵称」：…）
 *   2. 标明批次边界（这一批 N 条、来自 M 个人、跨几秒）
 *   3. 把 @ / 拍一拍 / 图片转成显式提示，而不是丢掉
 *   4. 明确告诉她：不用逐条回，接不上就不接（沉默权）
 *
 * 这个文件不碰模型、不碰存储，纯函数，方便测试。
 */

const MAX_TEXT = 500;
const DEFAULT_MAX_ROWS = 40;

function clip(text, limit = MAX_TEXT) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= limit ? s : s.slice(0, limit) + '…';
}

function nameOf(row) {
  const name = String(row?.senderName ?? row?.sender ?? '').trim();
  return name || '某人';
}

/** 单条消息 → 一行。返回 '' 表示这条不进上下文。 */
function renderRow(row, kind, imageIndex) {
  const text = clip(row?.text);
  const notes = [];
  if (row?.mentionMe) notes.push('@了你');
  if (row?.pat) notes.push('拍了拍你');
  if (row?.image || row?.imageId) notes.push(`发了张图 [附图 ${imageIndex}]`);

  if (!text && !notes.length) return '';

  const who = nameOf(row);
  const speaker = kind === 'group' ? `群友「${who}」` : `「${who}」`;
  const body = [text, notes.length ? `（${notes.join('，')}）` : ''].filter(Boolean).join(' ');
  return `${speaker}：${body}`;
}

/**
 * @param {{key?:string,name?:string,kind?:'group'|'private',rows?:Array}} batch
 * @returns {{text:string, rows:number, speakers:number, spanMs:number, truncated:boolean}}
 */
export function formatBatch(batch, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const kind = batch?.kind === 'private' ? 'private' : 'group';
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  const incoming = rows.filter((row) => row && row.outgoing !== true);
  const kept = incoming.slice(-maxRows);
  let imageIndex = 0;
  const lines = kept.map((row) => renderRow(row, kind, row.image || row.imageId ? ++imageIndex : undefined)).filter(Boolean);

  const speakers = new Set(kept.map(nameOf));
  const times = kept.map((row) => Number(row?.at)).filter((n) => Number.isFinite(n) && n > 0);
  const spanMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  // 群里同一个人常常想到一句发一句：连着发的几句要当成一段话，
  // 否则她会只接最后半句（"一个人在群里说的前后文"就是这么丢的）。
  let lastWho = '';
  const continued = kind === 'group' && kept.some((row) => {
    const who = nameOf(row);
    const same = who !== '' && who === lastWho;
    lastWho = who;
    return same;
  });

  const title = kind === 'group'
    ? `【微信群 · ${String(batch?.name ?? '未命名群').trim() || '未命名群'}】`
    : `【微信私聊 · ${String(batch?.name ?? '对方').trim() || '对方'}】`;

  const head = kind === 'group'
    ? `群里有 ${speakers.size} 个人在说话：`
    : '对方在说：';

  const foot = kept.length
    ? `（这一批 ${kept.length} 条，来自 ${speakers.size} 个人${spanMs > 0 ? `，跨了 ${Math.round(spanMs / 1000)} 秒` : ''}。` +
      (continued ? '同一个人连着发的几句是同一段话，连起来理解。' : '') +
      '不用逐条回答；接不上就不接，只回你真正想接的那一句。）'
    : '（这一批没有可读的文字。）';

  return {
    text: [title, head, ...lines, '', foot].join('\n'),
    rows: kept.length,
    speakers: speakers.size,
    spanMs,
    truncated: incoming.length > kept.length,
  };
}

/**
 * 解析她的输出 → 要发到微信的一条文本，或者沉默。
 *
 * 允许的写法（越宽松越好，宁可不回也不要发出去奇怪的东西）：
 *   SILENT / （不接） / 空        → 沉默
 *   RESPOND: 你好                  → 你好
 *   ```\n你好\n```                → 你好
 *   [STICKER:xxx]                 → 交给桥接处理（这里当作无文字）
 */
export function parseReply(raw, { maxChars = 300 } = {}) {
  let text = String(raw ?? '').trim();
  if (!text) return { kind: 'silent', text: '' };

  // 去掉整体代码块
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();

  if (/^(?:SILENT|（不接）|\(不接\)|不接|沉默)\s*$/i.test(text)) return { kind: 'silent', text: '' };
  if (/^\[STICKER:[^\]]*\]$/i.test(text)) return { kind: 'sticker', text: '' };
  // 她自己选的口令：单独一行 [表情] / [表情包] / [猫图]
  if (/^\[(?:表情|表情包|猫图|梗图)\]$/i.test(text)) return { kind: 'sticker', text: '', marker: text };

  // 只取最后一个 RESPOND 段（模型常先写一段说明再接正文）
  const parts = text.split(/^RESPOND\s*[:：]\s*/im).map((part) => part.trim()).filter(Boolean);
  if (parts.length) text = parts.at(-1);

  // 去掉模型爱加的引号
  text = text.replace(/^["“”'‘’](.*)["“”'‘’]$/s, '$1').trim();
  // 去掉旁白式括号（只去整行都是括号的）
  if (/^[（(][\s\S]*[）)]$/.test(text)) return { kind: 'silent', text: '' };
  if (!text) return { kind: 'silent', text: '' };

  const clipped = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
  return { kind: 'reply', text: clipped };
}
