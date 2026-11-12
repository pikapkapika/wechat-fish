import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmin, parseAdminCommand } from '../src/admin.js';
import { createBridge, buildStatus } from '../src/index.js';

const row = (text, sender = 'WXID_ADMIN') => ({ text, sender, senderName: 'Boss' });
for (const text of ['安静', '闭嘴', '安静点！', '别说话呀！']) {
  test(`管理员 ${text} 无限静音`, () => {
    const admin = createAdmin({ admins: ['wxid_admin'], now: () => 1000, file: null, log() {} });
    assert.equal(admin.process([row(text)]), true);
    assert.deepEqual(admin.snapshot(), { muted: true, until: 0, by: 'WXID_ADMIN' });
  });
}
for (const [text, minutes] of [['安静 30 分钟', 30], ['安静30分', 30], ['安静 2 小时', 120], ['安静2时', 120]]) {
  test(`定时 ${text}`, () => {
    const admin = createAdmin({ admins: ['wxid_admin'], now: () => 1000, file: null, log() {} });
    admin.process([row(text)]);
    assert.equal(admin.snapshot().until, 1000 + minutes * 60000);
  });
}
for (const text of ['说话', '出来', '可以说话了', '解除安静']) {
  test(`解除 ${text}`, () => {
    const admin = createAdmin({ admins: ['wxid_admin'], file: null, log() {} });
    admin.process([row('安静')]);
    admin.process([row(text)]);
    assert.equal(admin.snapshot().muted, false);
  });
}
test('非管理员和缺失名单不能指挥；普通讨论不命中', () => {
  const admin = createAdmin({ admins: ['other'], file: null });
  assert.equal(admin.process([row('安静')]), false);
  assert.equal(createAdmin({ file: null }).process([row('安静')]), false);
  for (const text of ['不要安静', '他说安静', '安静一下然后聊天', '安静0分']) assert.equal(parseAdminCommand(text), null);
});
test('持久化、启动读入、过期清理、空名单不沿用静音', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-admin-'));
  const file = join(dir, 'mute.json');
  let time = 1000;
  const options = { admins: ['wxid_admin'], file, now: () => time, log() {} };
  try {
    createAdmin(options).process([row('安静1分')]);
    assert.deepEqual(JSON.parse(readFileSync(file)), { muted: true, until: 61000, by: 'WXID_ADMIN', at: 1000 });
    const loaded = createAdmin(options);
    assert.equal(loaded.snapshot().muted, true);
    time = 61000;
    assert.deepEqual(loaded.snapshot(), { muted: false, until: 0, by: '' });
    assert.equal(JSON.parse(readFileSync(file)).muted, false);
    loaded.process([row('安静')]);
    assert.equal(createAdmin({ file }).snapshot().muted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('handleBatch 拦截、计数、自动恢复，以及 /status JSON 形状', async () => {
  let time = 1000;
  let calls = 0;
  let handler;
  const logs = [];
  const bridge = createBridge({
    config: { admins: ['wxid_admin'], whitelist: ['wechat:group:123'], reader: {}, hook: {}, fish: {} },
    log: x => logs.push(x),
    components: {
      now: () => time, muteFile: null, sender: {}, picker: {}, 
      fish: { async turn() { calls++; return { kind: 'silent' }; } },
      reader: { push: () => new Promise(() => {}) },
      hook: { async health() {}, async account() { return ''; } },
      http: { createServer(fn) { handler = fn; return { on() {}, listen() {}, close(cb) { cb(); } }; } },
    },
  });
  const { handleBatch, status } = bridge._internals;
  const batch = rows => ({ key: 'wechat:group:123', rows });
  await handleBatch(batch([row('安静1分')]));
  await handleBatch(batch([row('普通消息'), { text: '说话', sender: 'stranger', senderName: 'stranger' }]));
  assert.equal(calls, 0);
  assert.equal(status.counters.silents, 2);
  assert.ok(logs.some(line => line.includes('[muted] 跳过 2 条')));
  bridge.start();
  let body;
  handler({ method: 'GET', url: '/status' }, { writeHead() {}, end(x) { body = JSON.parse(x); } });
  assert.deepEqual(body.mute, { muted: true, until: 61000, by: 'WXID_ADMIN' });
  assert.deepEqual(Object.keys(body).filter(key => key !== 'mute'), Object.keys(buildStatus()));
  time = 61000;
  await handleBatch(batch([row('恢复')]));
  assert.equal(calls, 1);
  assert.equal(status.mute.muted, false);
  await handleBatch(batch([row('安静')]));
  await handleBatch(batch([row('说话')]));
  assert.equal(calls, 1);
  await handleBatch(batch([row('继续')]));
  assert.equal(calls, 2);
  await bridge.stop();
});


test('名字冒充无效：senderName 对得上也不算管理员', () => {
  const admin = createAdmin({ admins: ['boss'], now: () => 1000, file: null, log() {} });
  const fake = { text: '安静', sender: 'stranger', senderName: 'boss' };
  assert.equal(admin.process([fake]), false);
  assert.equal(admin.snapshot().muted, false);
});
