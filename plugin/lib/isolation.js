/**
 * isolation.js —— 启动自检：她的窝有没有被污染（2026-10-27）
 *
 * 只做判定，不改数据。三种情况要能说出来：
 *   1. 工作区里除了她还有别人的会话（说明屋子被共用，她的上下文会串）
 *   2. 她的会话不在自己那个工作区里（说明 home.json 和注册表对不上）
 *   3. 她的 cwd 不在 ~/.dsh-fish 下面（说明她的文件边界出了窝）
 */

import path from 'node:path';

/**
 * @param {object} o
 * @param {object} o.registry 宿主 workspaceRegistry（list/get）
 * @param {string} o.wsId 她的工作区 id
 * @param {string} o.sessionId 她的会话 id
 * @param {string} o.herDir 她的家目录（绝对路径）
 * @param {string} o.cwd 会话实际 cwd
 * @returns {{ok:boolean, reason:string, sessionIds:string[]}}
 */
export function checkHomeIsolation({ registry, wsId, sessionId, herDir, cwd } = {}) {
  const workspace = registry?.get?.(wsId) ?? null;
  const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(String) : [];

  if (!workspace) return { ok: false, reason: 'WORKSPACE_NOT_FOUND', sessionIds };
  if (!sessionIds.includes(String(sessionId))) return { ok: false, reason: 'SESSION_NOT_IN_HOME', sessionIds };
  if (sessionIds.length > 1) return { ok: false, reason: 'HOME_HAS_OTHER_SESSIONS', sessionIds };

  if (herDir && cwd) {
    const home = path.resolve(herDir).toLowerCase();
    const actual = path.resolve(String(cwd)).toLowerCase();
    if (actual !== home && !actual.startsWith(home + path.sep)) {
      return { ok: false, reason: 'CWD_OUTSIDE_HOME', sessionIds };
    }
  }

  return { ok: true, reason: '', sessionIds };
}

/** 把判定结果变成一句人话（给日志用，不给她看）。 */
export function describeIsolation(result) {
  if (result?.ok) return '';
  const ids = (result?.sessionIds ?? []).join(', ');
  switch (result?.reason) {
    case 'WORKSPACE_NOT_FOUND':
      return '她的工作区在注册表里找不到，home.json 可能过期了';
    case 'SESSION_NOT_IN_HOME':
      return `她的会话不在自己的工作区里（现有：${ids}）`;
    case 'HOME_HAS_OTHER_SESSIONS':
      return `她的工作区里混进了别的会话：${ids}——上下文会串`;
    case 'CWD_OUTSIDE_HOME':
      return '她的会话 cwd 跑出了 ~/.dsh-fish';
    default:
      return '隔离自检未通过：' + String(result?.reason ?? 'unknown');
  }
}
