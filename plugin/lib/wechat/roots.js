import path from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

function registryHome() {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\WeChatAgent', '/v', 'InstallDir'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const install = output.match(/InstallDir\s+REG_\w+\s+(.+)/i)?.[1]?.trim();
    return install ? path.join(install, 'data', 'workspace') : null;
  } catch { return null; }
}

/** Resolve at call time, so environment overrides also work after plugin load. */
export function findWeChatAgentHome({ env = process.env, exists = existsSync, readRegistry = registryHome } = {}) {
  const valid = value => {
    try { return typeof value === 'string' && value.trim() && exists(path.join(path.resolve(value), 'scripts', 'reader-api.py')) ? path.resolve(value) : null; }
    catch { return null; }
  };
  const candidates = [env.WECHAT_FISH_WECHAT_ROOT, env.WECHATAGENT_HOME,
    env.WECHAT_FISH_ROOT && path.join(env.WECHAT_FISH_ROOT, 'workspace'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'WeChatFish', 'workspace'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'WeChatAgent', 'data', 'workspace'),
    (env.PROGRAMFILES || env.ProgramFiles) && path.join(env.PROGRAMFILES || env.ProgramFiles, 'WeChatAgent', 'data', 'workspace')];
  for (const candidate of candidates) { const root = valid(candidate); if (root) return root; }
  try { return valid(readRegistry()); } catch { return null; }
}

export function findMemePacksRoot({ env = process.env, exists = existsSync } = {}) {
  try {
    const root = path.join(env.USERPROFILE || homedir(), '.dsh', 'meme-packs');
    return exists(root) ? path.resolve(root) : null;
  } catch { return null; }
}

export function captionRoots(options) {
  const home = findWeChatAgentHome(options);
  const packs = findMemePacksRoot(options);
  const outgoing = home && path.join(home, 'state', 'stickers', 'outgoing');
  const exists = options?.exists || existsSync;
  return [packs, outgoing].filter(root => { try { return root && exists(root); } catch { return false; } });
}
