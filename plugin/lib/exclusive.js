/**
 * exclusive.js —— 她的工具只给她用（2026-10-27）
 *
 * 问题：`restrict.js` 只作用在**她那条会话**上（`isHerAgent` 判定 cwd），
 * 她的六个工具却是 `ctx.tools.register()` 全局注册的。
 * 结果：用户自己的会话（比如主窗口）能看见、也能调用 `growth_commit` / `bili_speak`
 * ——她读不到别人，但别人能往她脑子里写。
 *
 * 修法：给**非她**的 agent 挂一把 guard，命中她的工具名就拒绝执行。
 * 为什么用 guard 而不是 restrict({deny})：guard 是执行侧的最后一米，
 * 同步、只拒绝、不改变工具列表的呈现；即使将来宿主改了 restrict 语义也不会失效。
 *
 * 注：这里刻意不隐藏工具（不 restrict），只拒绝执行——
 * 藏起来会让人以为"她没装"，留着拒绝能让我们在日志里看见真的有人在调。
 */

import { FISH_TOOLS, isHerAgent } from './restrict.js';

/** 只给她用的工具名。 */
export const EXCLUSIVE_TOOLS = Object.freeze([...FISH_TOOLS]);

const DENY_MESSAGE = '这个工具不属于这里。';

/**
 * @param {object} ctx 宿主 ctx
 * @param {{herDir:string, names?:string[], log?:(m:string)=>void}} opts
 * @returns {() => void} dispose
 */
export function registerFishToolExclusion(ctx, { herDir, names = EXCLUSIVE_TOOLS, log = () => {} } = {}) {
  if (!herDir) return () => {};
  const blocked = new Set(names.map((name) => String(name)));

  const off = ctx.on?.('agent/created', ({ agent } = {}) => {
    if (!agent) return;
    // 她自己放行
    if (isHerAgent(agent, herDir)) return;

    const tools = agent?.ctx?.tools;
    if (typeof tools?.guard !== 'function') {
      log('[dsh-fish] 别的会话没有 tools.guard，只能靠 restrict（她的工具仍可能被调用）');
      return;
    }
    try {
      const dispose = tools.guard((exec) => {
        const name = String(exec?.name ?? '');
        if (!name || !blocked.has(name)) return undefined;
        return DENY_MESSAGE;
      });
      try {
        agent.ctx.effect?.(() => dispose);
      } catch {
        /* 拿不到 effect 就靠父级回滚，不致命 */
      }
      log('[dsh-fish] 已给别的会话挂上封锁：她以外的 agent 不能调用她的工具');
    } catch (error) {
      log('[dsh-fish] 封锁没挂上：' + String(error?.message ?? error).slice(0, 140));
    }
  });

  return typeof off === 'function' ? off : () => {};
}
