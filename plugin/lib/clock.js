/**
 * clock.js —— 她能看到的时间（2026-10-30）
 *
 * 她原来没有任何时间感：提示词里既没有「现在几点」，历史消息也不带时间戳，
 * 于是早上的对话和下午的在它眼里是连着的，下午还在接「早饭吃了没」。
 *
 * 这里只做格式化，不做判断。管的是「现在是几点」这种环境信息，
 * 不是「她是什么样的人」。
 */

/** HH:MM */
export function clockOf(ms) {
  const d = new Date(Number(ms));
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 几小时前 / 几分钟前；比时钟更直白，模型不容易算错 */
export function agoOf(ms, now = Date.now()) {
  const diff = Math.max(0, Number(now) - Number(ms));
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}

/** 现在口头上的说法：早上 / 中午 / 下午 / 晚上…… */
export function partOfDay(hour) {
  const h = Number(hour) || 0;
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}

/** 她现在的钟：〔现在〕2026-10-30 周五 14:05（下午） */
export function nowLine(now = Date.now()) {
  const d = new Date(Number(now));
  const week = '日一二三四五六'[d.getDay()];
  const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return `〔现在〕${date} 周${week} ${clockOf(now)}（${partOfDay(d.getHours())}）`;
}
