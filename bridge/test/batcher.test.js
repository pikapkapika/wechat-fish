import test from 'node:test';
import assert from 'node:assert/strict';

import { createBatcher } from '../src/batcher.js';

const GROUP = 'wechat:group:100000000';
const OTHER = 'wechat:private:wxid_other';

/** 假时钟：只给 at 缺失时用；静默判定一律由 tick(假时间) 驱动，不碰真实定时器 */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

/** 一条真实形状的入站消息事件 */
function message(overrides = {}) {
  return {
    key: GROUP,
    name: '群名',
    kind: 'message',
    sender: 'wxid_a',
    senderName: '灯',
    text: '去不去 live',
    at: 1000,
    ...overrides,
  };
}

test('单条消息：静默未到期不出批，到期后 tick 出批', () => {
  const batcher = createBatcher({ silenceMs: 8000 });
  const event = message({ at: 1000 });

  assert.deepEqual(batcher.push(event), { flush: false });
  assert.equal(batcher.pendingCount(), 1);

  assert.equal(batcher.tick(8999), null, '1000 + 8000 = 9000，差 1ms 还不算到期');
  assert.equal(batcher.pendingCount(), 1);

  const batch = batcher.tick(9000);
  assert.deepEqual(batch, { key: GROUP, name: '群名', kind: 'group', rows: [event] });
  assert.equal(batcher.pendingCount(), 0);

  // 出批后清空：再 tick 不会重复交同一个批
  assert.equal(batcher.tick(9000), null);
  assert.equal(batcher.tick(20000), null);
});

test('多条消息合并成一批，rows 保持入批顺序', () => {
  const batcher = createBatcher({ silenceMs: 8000 });
  const first = message({ at: 1000, text: '一' });
  const second = message({ at: 2500, text: '二', sender: 'wxid_b' });
  const third = message({ at: 4000, text: '三' });

  for (const event of [first, second, third]) {
    assert.deepEqual(batcher.push(event), { flush: false });
  }
  assert.equal(batcher.pendingCount(), 3);

  // 静默以最后一条（at=4000）为准：4000 + 8000 = 12000
  assert.equal(batcher.tick(11999), null);
  const batch = batcher.tick(12000);
  assert.deepEqual(batch.rows, [first, second, third]);
  assert.equal(batch.key, GROUP);
  assert.equal(batch.name, '群名');
  assert.equal(batch.kind, 'group');
  assert.equal(batcher.pendingCount(), 0);
});

test('达到 maxRows 时 push 立刻交批，之后同 key 继续攒新批', () => {
  const batcher = createBatcher({ silenceMs: 8000, maxRows: 3 });
  const events = [0, 1, 2, 3].map((i) => message({ at: 1000 + i, text: `第${i}条` }));

  assert.deepEqual(batcher.push(events[0]), { flush: false });
  assert.deepEqual(batcher.push(events[1]), { flush: false });

  const full = batcher.push(events[2]);
  assert.equal(full.flush, true);
  assert.deepEqual(full.batch.rows, [events[0], events[1], events[2]]);
  assert.equal(batcher.pendingCount(), 0, '封顶出批后不残留');

  // 第 4 条开新批，不会被塞进已经交出去的旧批
  assert.deepEqual(batcher.push(events[3]), { flush: false });
  assert.equal(batcher.pendingCount(), 1);

  const second = batcher.tick(1003 + 8000);
  assert.deepEqual(second.rows, [events[3]]);
});

test('默认 maxRows = 40：第 40 条当场出批', () => {
  const batcher = createBatcher();
  const events = Array.from({ length: 40 }, (_, i) => message({ at: 1000 + i, text: `第${i}条` }));

  for (let i = 0; i < 39; i += 1) {
    assert.deepEqual(batcher.push(events[i]), { flush: false }, `第 ${i + 1} 条不该出批`);
  }
  assert.equal(batcher.pendingCount(), 39);

  const result = batcher.push(events[39]);
  assert.equal(result.flush, true);
  assert.equal(result.batch.rows.length, 40);
  assert.deepEqual(result.batch.rows, events);
  assert.equal(batcher.pendingCount(), 0);
});

test('不同 key 切换时旧批先出，新事件进新批', () => {
  const batcher = createBatcher({ silenceMs: 8000 });
  const a1 = message({ at: 1000, text: 'A1' });
  const a2 = message({ at: 1500, text: 'A2' });
  const b1 = message({ key: OTHER, name: '私聊', at: 2000, text: 'B1', sender: 'wxid_other' });

  assert.deepEqual(batcher.push(a1), { flush: false });
  assert.deepEqual(batcher.push(a2), { flush: false });

  const switched = batcher.push(b1);
  assert.equal(switched.flush, true);
  assert.deepEqual(switched.batch, { key: GROUP, name: '群名', kind: 'group', rows: [a1, a2] });
  assert.equal(batcher.pendingCount(), 1, 'B 的事件已进新批');

  const batch = batcher.tick(2000 + 8000);
  assert.deepEqual(batch, { key: OTHER, name: '私聊', kind: 'private', rows: [b1] });

  // 再切回 A：旧批（B）先出
  assert.deepEqual(batcher.push(message({ at: 11000, text: 'A3' })), { flush: false });
  const back = batcher.push(message({ key: OTHER, at: 11100, text: 'B2', sender: 'wxid_other' }));
  assert.equal(back.flush, true);
  assert.equal(back.batch.key, GROUP);
  assert.deepEqual(back.batch.rows.map((row) => row.text), ['A3']);
});

test('自己的消息与非消息事件不进批，也不打断正在攒的批', () => {
  const batcher = createBatcher({ silenceMs: 8000, selfId: 'wxid_me' });
  const kept = message({ at: 1000 });
  assert.deepEqual(batcher.push(kept), { flush: false });

  const ignored = [
    message({ at: 1100, isSend: true }), // 自己刚发出去的
    message({ at: 1200, isSend: 1 }), // 数字标记
    message({ at: 1300, isSelf: true }),
    message({ at: 1400, outbound: true }),
    message({ at: 1500, direction: 'out' }),
    message({ at: 1600, sender: 'wxid_me' }), // 注入 selfId 兜底
    message({ at: 1700, kind: 'receipt' }), // 回执类事件
    message({ at: 1800, kind: 'sticker' }),
    message({ at: 1900, kind: 'self' }),
    message({ at: 2000, text: '', image: false }), // 没正文又没图
    message({ at: 2100, text: '   ' }), // 纯空白等于没正文
    message({ at: 2200 }), // 下面改成缺 key
  ];
  ignored[ignored.length - 1].key = undefined;

  for (const event of ignored) {
    assert.deepEqual(batcher.push(event), { flush: false }, JSON.stringify(event));
  }

  assert.equal(batcher.pendingCount(), 1, '只留下最早那条正常消息');

  const batch = batcher.tick(9000);
  assert.deepEqual(batch.rows, [kept]);

  // 非对象事件也只是忽略，不抛异常
  assert.deepEqual(batcher.push(null), { flush: false });
  assert.deepEqual(batcher.push(undefined), { flush: false });
  assert.deepEqual(batcher.push('message'), { flush: false });
  assert.equal(batcher.pendingCount(), 0);
});

test('只有图片没有正文的消息可以入批', () => {
  const batcher = createBatcher({ silenceMs: 8000 });
  const image = message({ at: 1000, text: '', image: { localId: 7, serverId: 8 } });

  assert.deepEqual(batcher.push(image), { flush: false });
  assert.equal(batcher.pendingCount(), 1);

  const batch = batcher.tick(9000);
  assert.deepEqual(batch.rows, [image]);
});

test('flushNow 空批返回 null；有批时强制出批，重复调用得 null', () => {
  const batcher = createBatcher({ silenceMs: 8000 });
  assert.equal(batcher.flushNow(), null, '没有任何事件时返回 null');
  assert.equal(batcher.pendingCount(), 0);

  const event = message({ at: 1000 });
  assert.deepEqual(batcher.push(event), { flush: false });

  const batch = batcher.flushNow();
  assert.deepEqual(batch, { key: GROUP, name: '群名', kind: 'group', rows: [event] });
  assert.equal(batcher.pendingCount(), 0);
  assert.equal(batcher.flushNow(), null);

  // 关停后再来事件：静默判定从头算
  assert.deepEqual(batcher.push(message({ at: 5000 })), { flush: false });
  assert.equal(batcher.flushNow().rows.length, 1);
  assert.equal(batcher.pendingCount(), 0);
});

test('at 缺失时用注入的 now 兜底，tick 省略参数也读同一个时钟', () => {
  const clock = fakeClock(0);
  const batcher = createBatcher({ silenceMs: 8000, now: clock.now });
  const event = message({ at: undefined, text: '没时间戳' });
  delete event.at;

  assert.deepEqual(batcher.push(event), { flush: false });

  clock.set(7999);
  assert.equal(batcher.tick(), null);
  clock.set(8000);
  const batch = batcher.tick();
  assert.deepEqual(batch.rows, [event]);

  // at 是坏数字时同样兜底到时钟，不产生 NaN 比较
  clock.set(20000);
  const broken = message({ at: NaN, text: '坏时间戳' });
  assert.deepEqual(batcher.push(broken), { flush: false });
  clock.set(28000);
  assert.equal(batcher.tick().rows.length, 1);
});

test('批的 kind：优先会话类型字段，缺省按 key 推导', () => {
  const group = createBatcher({ silenceMs: 8000 });
  group.push(message({ key: 'wechat:group:1', at: 1000 }));
  assert.equal(group.flushNow().kind, 'group');

  const priv = createBatcher({ silenceMs: 8000 });
  priv.push(message({ key: 'wechat:private:wxid_x', at: 1000 }));
  assert.equal(priv.flushNow().kind, 'private');

  const explicit = createBatcher({ silenceMs: 8000 });
  explicit.push(message({ key: 'wechat:weird:1', sessionType: 'group', at: 1000 }));
  assert.equal(explicit.flushNow().kind, 'group');

  // 什么线索都没有时兜底 private，与 /turn 的 kind 字段形状一致
  const fallback = createBatcher({ silenceMs: 8000 });
  fallback.push(message({ key: 'mystery', at: 1000 }));
  assert.equal(fallback.flushNow().kind, 'private');
});

test('silenceMs = 0 时 tick 立刻出批；maxRows 兜到至少 1', () => {
  const zero = createBatcher({ silenceMs: 0 });
  zero.push(message({ at: 1000 }));
  assert.equal(zero.tick(1000).rows.length, 1);

  const one = createBatcher({ maxRows: 0 });
  const event = message({ at: 1000 });
  const result = one.push(event);
  assert.equal(result.flush, true);
  assert.deepEqual(result.batch.rows, [event]);
});
