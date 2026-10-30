import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findWeChatAgentHome, resolvePaths } from '../src/paths.js';
import { createBridge } from '../src/index.js';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'bridge-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = relative => {
    const dir = path.join(root, relative);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'reader-api.py'), '');
    return dir;
  };
  return { root, workspace };
}
test('paths: environment wins before LOCALAPPDATA', t => {
  const { root, workspace } = fixture(t);
  const home = workspace('override');
  workspace('Programs/WeChatAgent/data/workspace');
  assert.equal(findWeChatAgentHome({ env: { WECHATAGENT_HOME: home, LOCALAPPDATA: root }, readRegistry: () => null }), home);
});
test('paths: LOCALAPPDATA fallback', t => {
  const { root, workspace } = fixture(t);
  const home = workspace('Programs/WeChatAgent/data/workspace');
  assert.equal(findWeChatAgentHome({ env: { LOCALAPPDATA: root }, readRegistry: () => null }), home);
});
test('paths: missing installation returns null, including registry errors', t => {
  const { root } = fixture(t);
  assert.equal(findWeChatAgentHome({ env: { LOCALAPPDATA: root }, readRegistry: () => { throw Error('unavailable'); } }), null);
});
test('paths: empty legacy packsDir discovers packs and config paths override legacy', t => {
  const { root, workspace } = fixture(t);
  const home = workspace('home');
  const packs = path.join(root, '.dsh', 'meme-packs'); mkdirSync(packs, { recursive: true });
  const options = { env: { USERPROFILE: root, WECHATAGENT_HOME: home }, readRegistry: () => null };
  const discovered = resolvePaths({ memes: { packsDir: '' } }, options);
  assert.equal(discovered.packsDir, packs);
  assert.equal(discovered.outgoingDir, path.join(home, 'state', 'stickers', 'outgoing'));
  assert.equal(resolvePaths({ paths: { memePacks: root }, memes: { packsDir: 'legacy' } }, options).packsDir, root);
});
test('bridge: absent discovered paths never crash startup construction', () => {
  const logs = [];
  const bridge = createBridge({ config: { memes: { packsDir: '', enabled: true } }, log: message => logs.push(message), components: {
    pathsOptions: { env: {}, exists: () => false, readRegistry: () => null },
    reader: {}, hook: {}, sender: {}, fish: {}, picker: {}, pacing: {}, batcher: {}, dedupe: {},
  } });
  assert.ok(bridge);
  assert.deepEqual(logs, ['[paths] 找不到微信目录，表情池功能关闭']);
});
