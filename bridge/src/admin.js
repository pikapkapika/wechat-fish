import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../state/mute.json', import.meta.url));
const empty = () => ({ muted: false, until: 0, by: '', at: 0 });

export function parseAdminCommand(text) {
  // 整句匹配，不能把引用、否定或普通讨论误当作指令。
  const value = String(text ?? '').replace(/\s/gu, '').replace(/^[\p{P}]+|[\p{P}]+$/gu, '')
    .replace(/[啊呀吧啦呢哦噢哈哎呗嘛了]+$/u, '');
  if (/^(说话|出来|可以说话|解除安静)$/u.test(value)) return { muted: false, duration: 0 };
  if (/^(安静|闭嘴|别说话|安静点)$/u.test(value)) return { muted: true, duration: 0 };
  const match = /^(?:安静|闭嘴|别说话|安静点)(\d+)(分钟|分|小时|时)$/u.exec(value);
  if (!match) return null;
  const duration = Number(match[1]) * (/^(小时|时)$/.test(match[2]) ? 3600000 : 60000);
  return duration > 0 && Number.isSafeInteger(duration) ? { muted: true, duration } : null;
}

export function createAdmin({ admins = [], now = Date.now, file = defaultFile, log = console.log } = {}) {
  const names = new Set((Array.isArray(admins) ? admins : [])
    .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().toLowerCase()));
  let state = empty();
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(state) + '\n');
    renameSync(file + '.tmp', file);
  }
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof saved.muted === 'boolean' && Number.isFinite(saved.until) && saved.until >= 0 && typeof saved.by === 'string') {
        state = { muted: saved.muted, until: saved.until, by: saved.by, at: Number(saved.at) || 0 };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log('[admin] 读取静音状态失败: ' + error.message);
    }
  }
  function snapshot() {
    if ((state.muted && state.until !== 0 && state.until <= now()) || (names.size === 0 && state.muted)) {
      state = empty();
      persist();
    }
    return { muted: state.muted, until: state.until, by: state.by };
  }
  snapshot();
  function process(rows) {
    let handled = false;
    for (const row of rows ?? []) {
      // 只认唯一 id。senderName 是显示名，谁都能改，不能作为身份依据。
    const identities = [row.talkerId, row.sender];
      if (!identities.some(x => typeof x === 'string' && names.has(x.trim().toLowerCase()))) continue;
      const command = parseAdminCommand(row.text ?? row.content);
      if (!command) continue;
      const at = now();
      const by = String(row.talkerId || row.sender || '');
      state = { muted: command.muted, until: command.muted && command.duration ? at + command.duration : 0, by, at };
      persist();
      log(`[admin] ${command.muted ? '静音' : '解除静音'} by ${by}`);
      handled = true;
    }
    return handled;
  }
  return { process, snapshot };
}
