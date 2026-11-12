/**
 * log.js —— 桥接的日志分级（2026-10-30）
 *
 * 为什么不是每个调用点都改一遍：桥接里的 log() 调用点有三四十处，
 * 逐条改既容易漏，也会让 diff 淹掉真正的逻辑。这里在**出口处**做一次分类：
 * 按内容判定 level，低于阈值的直接丢掉，留下的前面加 [ERROR]/[WARN]/[INFO]/[DEBUG]。
 *
 * 级别（数字越小越要紧）：
 *   error —— 发送失败、批次异常、进程级兜底
 *   warn  —— 白名单外丢弃、静默跳过、图库/画图回落
 *   info  —— 启动、允许名单、回不回的结论、发送成功（默认）
 *   debug —— 每 60 秒的 SSE 换连接、图片 id、原始事件、自动补标
 *
 * 阈值来自 config.logLevel（缺省 info），也可用环境变量 WECHAT_FISH_LOG_LEVEL 覆盖。
 */

export const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export const LEVEL_NAMES = ['error', 'warn', 'info', 'debug'];

const RULES = [
  // 真正出错
  [/\[fatal-guard\]/, 'error'],
  [/\[send\] failed/, 'error'],
  [/\[sticker\] failed/, 'error'],
  [/\[batch\] 处理失败/, 'error'],
  [/\[fatal\]/i, 'error'],
  // 需要看一眼但不算故障
  [/\[skip\]/, 'warn'],
  [/\[muted\]/, 'warn'],
  [/\[meme\].*(失败|为空|回落)/, 'warn'],
  [/\[draw\] 失败/, 'warn'],
  [/\[labels\].*(失败|坏了)/, 'warn'],
  [/\[catchup\] 跳过/, 'warn'],
  [/\[paths\] 找不到/, 'warn'],
  // 高频、只在排查时看
  [/SSE max age/, 'debug'],
  [/\[event\]/, 'debug'],
  [/\[image\]/, 'debug'],
  [/\[labels\] 自动补标/, 'debug'],
  [/\[meme\] (本地图|联网补图|图库)/, 'debug'],
  [/\[whitelist\] 已热更新/, 'debug'],
  [/\[draw\] 使用生成图/, 'debug'],
];

/** 这条日志该算哪一级；没命中就是 info */
export function levelOf(text) {
  const s = String(text ?? '');
  for (const [re, level] of RULES) if (re.test(s)) return level;
  return 'info';
}

/** 解析阈值；非法值退回 info */
export function normalizeLevel(value, fallback = 'info') {
  const s = String(value ?? '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVELS, s)) return s;
  return fallback;
}

/**
 * 包一层出口：分类 + 过滤 + 加标签。返回的函数签名与 log(string) 一致，调用点不用动。
 * @param {(line:string)=>void} write 真正写日志的函数（main.js 里带时间戳）
 * @param {string} level 阈值
 */
export function createLeveledLog(write, level = 'info') {
  const threshold = LEVELS[normalizeLevel(level)];
  return (text) => {
    const lv = levelOf(text);
    if (LEVELS[lv] > threshold) return;
    write(`[${lv.toUpperCase()}] ${text}`);
  };
}
