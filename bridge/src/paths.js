import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

function registryHome() {
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\WeChatAgent', '/v', 'InstallDir'], { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const install = output.match(/InstallDir\s+REG_\w+\s+(.+)/i)?.[1]?.trim();
    return install ? path.join(install, 'data', 'workspace') : null;
  } catch { return null; }
}
export function findWeChatAgentHome({ env = process.env, exists = fs.existsSync, readRegistry = registryHome } = {}) {
  const valid = value => {
    try { return typeof value === 'string' && value.trim() && exists(path.join(path.resolve(value), 'scripts', 'reader-api.py')) ? path.resolve(value) : null; }
    catch { return null; }
  };
  for (const candidate of [env.WECHATAGENT_HOME,
    // 独立安装包：先认自己装在哪，不依赖 WeChatAgent
    env.WECHAT_FISH_ROOT && path.join(env.WECHAT_FISH_ROOT, 'workspace'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'WeChatFish', 'workspace'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'WeChatAgent', 'data', 'workspace'),
    (env.PROGRAMFILES || env.ProgramFiles) && path.join(env.PROGRAMFILES || env.ProgramFiles, 'WeChatAgent', 'data', 'workspace')]) {
    const root = valid(candidate); if (root) return root;
  }
  try { return valid(readRegistry()); } catch { return null; }
}
export function findMemePacksRoot({ env = process.env, exists = fs.existsSync } = {}) {
  try {
    const root = path.join(env.USERPROFILE || os.homedir(), '.dsh', 'meme-packs');
    return exists(root) ? path.resolve(root) : null;
  } catch { return null; }
}
export function resolvePaths(config = {}, options = {}) {
  const base = config.__configPath ? path.dirname(path.resolve(config.__configPath)) : process.cwd();
  const resolve = value => typeof value === 'string' && value.trim() ? path.resolve(base, value) : null;
  const home = resolve(config.paths?.wechatAgentHome) || findWeChatAgentHome(options);
  const packsDir = resolve(config.paths?.memePacks) || resolve(config.memes?.packsDir) || findMemePacksRoot(options);
  const outgoingDir = resolve(config.paths?.outgoingStickers) || resolve(config.stickers?.dir) || (home && path.join(home, 'state', 'stickers', 'outgoing'));
  // Use the installed bundled Python without pinning a runtime version.
  let pythonPath = resolve(config.memes?.pythonPath);
  if (!pythonPath && home) {
    const runtimes = path.join(home, '..', 'runtimes');
    try {
      for (const entry of fs.readdirSync(runtimes).sort().reverse()) {
        const candidate = path.join(runtimes, entry, 'python', 'python.exe');
        if (fs.existsSync(candidate)) { pythonPath = path.resolve(candidate); break; }
      }
    } catch { /* Optional runtime: converter retains its own fallback. */ }
  }
  return { wechatAgentHome: home, packsDir, outgoingDir, pythonPath };
}
