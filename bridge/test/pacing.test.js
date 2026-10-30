import test from 'node:test';
import assert from 'node:assert/strict';

import { createPacing } from '../src/pacing.js';

/**
 * 假时钟 + 假 sleep：sleep 只记录「睡了多久」并把假时钟往前推，
 * 所以整套用例毫秒级跑完，不碰真实定时器。
 */
function createHarness(options = {}) {
  let current = 0;
  const sleeps = [];

  const clock = {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    get value() {
      return current;
    },
  };

  const sleep = async (ms) => {
    sleeps.push(ms);
    current += ms;
  };

  const pacing = createPacing({ now: clock.now, sleep, ...options });
  return { pacing, clock, sleeps };
}

test('delayMs = round(baseMs * (lo + random() * (hi - lo)))', () => {
  const at = (r) => createHarness({ baseMs: 10000, jitter: [0.6, 3.0], random: () => r }).pacing;

  assert.equal(at(0).delayMs(), 6000, 'random=0 → 下限倍率 0.6');
  assert.equal(at(1).delayMs(), 30000, 'random=1 → 上限倍率 3.0');
  assert.equal(at(0.5).delayMs(), 18000, '中点 1.8 倍');
  assert.equal(at(0.123).delayMs(), 8952, '0.6 + 0.123 * 2.4 = 0.8952');

  // 每次调用重新取随机数，不是缓存一个值
  const seq = [0, 0.5, 1];
  let i = 0;
  const { pacing } = createHarness({
    baseMs: 10000,
    jitter: [0.6, 3.0],
    random: () => seq[i++ % seq.length],
  });
  assert.equal(pacing.delayMs(), 6000);
  assert.equal(pacing.delayMs(), 18000);
  assert.equal(pacing.delayMs(), 30000);
});

test('delayMs 四舍五入到整数毫秒', () => {
  // 1000 * 1.0005 = 1000.5 → 1001
  const up = createHarness({ baseMs: 1000, jitter: [1.0005, 1.0005], random: () => 0 });
  assert.equal(up.pacing.delayMs(), 1001);

  // 1000 * 1.0004 = 1000.4 → 1000
  const down = createHarness({ baseMs: 1000, jitter: [1.0004, 1.0004], random: () => 0 });
  assert.equal(down.pacing.delayMs(), 1000);

  assert.equal(Number.isInteger(down.pacing.delayMs()), true);
});

test('delayMs 下限 800ms', () => {
  const cases = [
    { baseMs: 100, jitter: [0, 0] }, // 原始值 0
    { baseMs: 0, jitter: [0.6, 3.0] }, // baseMs 为 0
    { baseMs: 100, jitter: [0.1, 0.1] }, // 原始值 10
    { baseMs: 799, jitter: [1, 1] }, // 原始值 799
  ];

  for (const options of cases) {
    const { pacing } = createHarness({ ...options, random: () => 0 });
    assert.equal(pacing.delayMs(), 800, JSON.stringify(options));
  }

  // 正好 800 不被抬高
  const exact = createHarness({ baseMs: 800, jitter: [1, 1], random: () => 0 });
  assert.equal(exact.pacing.delayMs(), 800);
});

test('delayMs 用到非法的 random 返回值也不返回 NaN', () => {
  const { pacing } = createHarness({ baseMs: 10000, jitter: [0.6, 3.0], random: () => NaN });
  assert.equal(pacing.delayMs(), 6000);
  assert.equal(Number.isFinite(pacing.delayMs()), true);
});

test('wait 先按 delayMs 睡一次，kind 不影响时长', async () => {
  const { pacing, sleeps, clock } = createHarness({
    baseMs: 1000,
    jitter: [1, 1],
    maxPerMinute: 10,
  });

  const returned = await pacing.wait('text');
  assert.equal(returned, undefined, 'wait 返回 Promise<void>');
  assert.deepEqual(sleeps, [1000]);
  assert.equal(clock.value, 1000);
  assert.equal(pacing.recentCount(), 1);

  await pacing.wait('sticker');
  assert.deepEqual(sleeps, [1000, 1000], 'kind 换成 sticker 时长不变');
  assert.equal(clock.value, 2000);
  assert.equal(pacing.recentCount(), 2);
});

test('wait 返回的是 Promise', () => {
  const { pacing } = createHarness({ baseMs: 1000, jitter: [1, 1] });
  const pending = pacing.wait('text');
  assert.equal(typeof pending.then, 'function');
  return pending;
});

test('每分钟配额：达到上限后等到最早一条滑出窗口', async () => {
  const { pacing, sleeps, clock } = createHarness({
    baseMs: 1000,
    jitter: [1, 1],
    maxPerMinute: 2,
  });

  await pacing.wait('a'); // 睡 1000 → t=1000，记 1000
  await pacing.wait('b'); // 睡 1000 → t=2000，记 2000
  assert.equal(pacing.recentCount(), 2);

  // 第三次：先照常睡 1000 → t=3000，配额已满
  // 最早一条在 t=1000，要等到 t=61000 才滑出窗口 → 额外睡 58000
  await pacing.wait('c');

  assert.deepEqual(sleeps, [1000, 1000, 1000, 58000]);
  assert.equal(clock.value, 61000);
  // 窗口内的两条变成 t=2000 与 t=61000
  assert.equal(pacing.recentCount(), 2);
});

test('配额为 1 时，每次发送都等满一分钟窗口（滑动窗口不断后移）', async () => {
  const { pacing, sleeps, clock } = createHarness({
    baseMs: 1000,
    jitter: [1, 1],
    maxPerMinute: 1,
  });

  await pacing.wait('a');
  assert.deepEqual(sleeps, [1000]);
  assert.equal(clock.value, 1000);

  await pacing.wait('b');
  assert.deepEqual(sleeps, [1000, 1000, 59000]);
  assert.equal(clock.value, 61000);

  await pacing.wait('c');
  assert.deepEqual(sleeps, [1000, 1000, 59000, 1000, 59000]);
  assert.equal(clock.value, 121000);

  assert.equal(pacing.recentCount(), 1);
});

test('recentCount 随窗口滑出自然衰减', async () => {
  const { pacing, clock } = createHarness({
    baseMs: 1000,
    jitter: [1, 1],
    maxPerMinute: 5,
  });

  await pacing.wait('a'); // t=1000
  await pacing.wait('b'); // t=2000
  assert.equal(pacing.recentCount(), 2);

  clock.advance(58000); // t=60000
  assert.equal(pacing.recentCount(), 2);

  clock.advance(1000); // t=61000，t=1000 那条滑出
  assert.equal(pacing.recentCount(), 1);

  clock.advance(1000); // t=62000，t=2000 那条也滑出
  assert.equal(pacing.recentCount(), 0);
});

test('默认参数：baseMs 10000、jitter [0.6, 3.0]', () => {
  const lo = createHarness({ random: () => 0 });
  assert.equal(lo.pacing.delayMs(), 6000);

  const hi = createHarness({ random: () => 1 });
  assert.equal(hi.pacing.delayMs(), 30000);
});

test('默认 maxPerMinute = 10', async () => {
  const { pacing, sleeps } = createHarness({
    baseMs: 100,
    jitter: [0, 0], // 每次都夹到 800ms 下限
    random: () => 0,
  });

  for (let i = 0; i < 10; i += 1) await pacing.wait('text');
  assert.equal(pacing.recentCount(), 10);
  assert.deepEqual(sleeps, new Array(10).fill(800));

  // 第 11 次：先睡 800 到 t=8800，第一条在 t=800，
  // 要等到 t=60800 才滑出 → 再等 52000
  await pacing.wait('text');
  assert.deepEqual(sleeps, [...new Array(10).fill(800), 800, 52000]);
  assert.equal(pacing.recentCount(), 10);
});
