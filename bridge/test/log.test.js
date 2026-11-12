import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeveledLog, levelOf, normalizeLevel } from '../src/log.js';

test('levelOf：按内容分类', () => {
  assert.equal(levelOf('[send] failed HTTP 500'), 'error');
  assert.equal(levelOf('[batch] 处理失败（已兜底，进程继续）: x'), 'error');
  assert.equal(levelOf('[skip] wechat:group:1 不在白名单，本批 2 条丢掉'), 'warn');
  assert.equal(levelOf('[muted] 跳过 3 条'), 'warn');
  assert.equal(levelOf('[meme] 图库失败 boom'), 'warn');
  assert.equal(levelOf('[reader] /api/v1/push/messages: SSE max age, 主动换连接'), 'debug');
  assert.equal(levelOf('[image] id=abc image=true key=wechat:group:1'), 'debug');
  assert.equal(levelOf('[bridge] started'), 'info');
  assert.equal(levelOf('[fish] 结果 reply : 在。'), 'info');
  assert.equal(levelOf('[send] ok -> wechat:private:1 200 : 在。'), 'info');
});

test('normalizeLevel：只认四档，别的退回 fallback', () => {
  assert.equal(normalizeLevel('debug'), 'debug');
  assert.equal(normalizeLevel('WARN'), 'warn');
  assert.equal(normalizeLevel('nope'), 'info');
  assert.equal(normalizeLevel(undefined), 'info');
  assert.equal(normalizeLevel('nope', 'debug'), 'debug');
});

test('createLeveledLog：阈值以下不输出，输出带级别标签', () => {
  const lines = [];
  const log = createLeveledLog((line) => lines.push(line), 'info');
  log('[bridge] started');
  log('[image] id=abc');
  log('[skip] not in whitelist');
  log('[send] failed HTTP 500');
  assert.deepEqual(lines, [
    '[INFO] [bridge] started',
    '[WARN] [skip] not in whitelist',
    '[ERROR] [send] failed HTTP 500',
  ]);
});

test('createLeveledLog：debug 阈值全放，error 阈值只剩错误', () => {
  const all = [];
  const debug = createLeveledLog((line) => all.push(line), 'debug');
  debug('[image] id=abc');
  assert.equal(all.length, 1);
  assert.match(all[0], /^\[DEBUG\] /);

  const onlyError = [];
  const err = createLeveledLog((line) => onlyError.push(line), 'error');
  err('[bridge] started');
  err('[skip] x');
  err('[send] failed y');
  assert.deepEqual(onlyError, ['[ERROR] [send] failed y']);
});
