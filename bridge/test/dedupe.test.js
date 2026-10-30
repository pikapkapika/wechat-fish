import test from 'node:test';
import assert from 'node:assert/strict';

import { createDedupe } from '../src/dedupe.js';

/** 假时钟：测试用 now 注入推进 TTL，不依赖真实定时器 */
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

test('重复 remember 后再 seen 为 true，size 不重复计数', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ now: clock.now });

  assert.equal(dedupe.seen('m1'), false);
  dedupe.remember('m1');
  assert.equal(dedupe.seen('m1'), true);
  assert.equal(dedupe.size(), 1);

  dedupe.remember('m1');
  dedupe.remember('m1');
  assert.equal(dedupe.seen('m1'), true);
  assert.equal(dedupe.size(), 1);
  assert.equal(dedupe.seen('m2'), false);
});

test('空字符串与非字符串 id 一律 false，且不会被写入', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ now: clock.now });

  assert.equal(dedupe.seen(''), false);
  dedupe.remember('');
  assert.equal(dedupe.size(), 0);

  for (const bad of [null, undefined, 0, 123, true, {}, [], Symbol('x')]) {
    assert.equal(dedupe.seen(bad), false);
    assert.doesNotThrow(() => dedupe.remember(bad));
    assert.equal(dedupe.size(), 0);
  }

  // 合法 id 仍然正常工作，说明非法 id 没有污染状态
  dedupe.remember('ok');
  assert.equal(dedupe.seen('ok'), true);
  assert.equal(dedupe.size(), 1);
});

test('TTL 到期失效：边界正好是 ttl 毫秒', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ ttlMs: 1000, now: clock.now });

  dedupe.remember('a');
  clock.advance(999);
  assert.equal(dedupe.seen('a'), true);

  clock.advance(1); // t = 1000，到期
  assert.equal(dedupe.seen('a'), false);
  assert.equal(dedupe.size(), 0);
});

test('TTL 各自独立：过期条目自动清理，不影响未过期条目', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ ttlMs: 1000, now: clock.now });

  dedupe.remember('old');
  clock.advance(500);
  dedupe.remember('new');

  clock.advance(500); // t = 1000：old 到期，new 还剩 500
  assert.equal(dedupe.size(), 1);
  assert.equal(dedupe.seen('old'), false);
  assert.equal(dedupe.seen('new'), true);
  assert.equal(dedupe.size(), 1);

  clock.advance(500); // t = 1500：new 也到期
  assert.equal(dedupe.size(), 0);
  assert.equal(dedupe.seen('new'), false);
});

test('seen 不续期：查过不会延长存活时间', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ ttlMs: 1000, now: clock.now });

  dedupe.remember('a');
  clock.advance(500);
  assert.equal(dedupe.seen('a'), true);

  clock.advance(499); // t = 999
  assert.equal(dedupe.seen('a'), true);

  clock.advance(1); // t = 1000，即使一直在查也应该过期
  assert.equal(dedupe.seen('a'), false);
});

test('超过 max 时淘汰最旧的', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ max: 3, now: clock.now });

  for (const id of ['a', 'b', 'c']) dedupe.remember(id);
  assert.equal(dedupe.size(), 3);

  dedupe.remember('d');
  assert.equal(dedupe.size(), 3);
  assert.equal(dedupe.seen('a'), false, '最旧的 a 应被淘汰');
  assert.equal(dedupe.seen('b'), true);
  assert.equal(dedupe.seen('c'), true);
  assert.equal(dedupe.seen('d'), true);

  // 再挤一个：b 变成最旧
  dedupe.remember('e');
  assert.equal(dedupe.size(), 3);
  assert.equal(dedupe.seen('b'), false, 'b 应被淘汰');
  assert.equal(dedupe.seen('e'), true);
});

test('重复 remember 刷新过期时间并移到最新，不会优先被淘汰', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ ttlMs: 1000, max: 2, now: clock.now });

  dedupe.remember('a');
  clock.advance(400);
  dedupe.remember('b');

  clock.advance(200);
  dedupe.remember('a'); // t = 600，a 刷新到队尾

  dedupe.remember('c'); // 超上限，应淘汰最旧的 b
  assert.equal(dedupe.size(), 2);
  assert.equal(dedupe.seen('b'), false);
  assert.equal(dedupe.seen('a'), true);
  assert.equal(dedupe.seen('c'), true);

  // a 的新过期时刻 = 600 + 1000 = 1600
  clock.set(1599);
  assert.equal(dedupe.seen('a'), true);
  clock.set(1600);
  assert.equal(dedupe.seen('a'), false);
});

test('默认 ttlMs = 600000', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ now: clock.now });

  dedupe.remember('a');
  clock.advance(599999);
  assert.equal(dedupe.seen('a'), true);
  clock.advance(1);
  assert.equal(dedupe.seen('a'), false);
});

test('默认 max = 5000，第 5001 个 id 挤掉最旧的', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ now: clock.now });

  for (let i = 0; i < 5000; i += 1) dedupe.remember(`id-${i}`);
  assert.equal(dedupe.size(), 5000);

  dedupe.remember('id-5000');
  assert.equal(dedupe.size(), 5000);
  assert.equal(dedupe.seen('id-0'), false);
  assert.equal(dedupe.seen('id-1'), true);
  assert.equal(dedupe.seen('id-5000'), true);
});

test('max = 0 时什么都不记', () => {
  const clock = fakeClock();
  const dedupe = createDedupe({ max: 0, now: clock.now });

  dedupe.remember('a');
  assert.equal(dedupe.size(), 0);
  assert.equal(dedupe.seen('a'), false);
});
