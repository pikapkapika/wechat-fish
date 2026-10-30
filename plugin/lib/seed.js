/**
 * seed.js —— 「基础人格卡」的唯一入口（2026-10-27）
 *
 * 为什么不是"人格设置"：
 *   dsh-fish 的红线是「人格只能长出来」。设置页里给人格输入框，
 *   等于把产品变回角色扮演（AGENTS.md 第 2 条）。
 *
 *   唯一被允许的例外是 seed：它是**第一个事实**，写进事件流，
 *   之后只能由她自己 revise。所以这里把它做成一次性、不可改、
 *   不可删的入口——写完就锁死。
 *
 * 三条边界（与 AGENTS.md 0.5.3 一致）：
 *   1. 只写 seed 事件，不写配置；
 *   2. 只在她还没有起点时生效（有 seed 就拒绝）；
 *   3. 不带任何成长结果（天数、判断、疤、日记都不迁）。
 */

import { readEvents, appendEvent } from './store.js';

/** seed 正文上限：够写一张基础人格卡，又不会把上下文吃光。 */
// 对齐 schema 的 2000 字上限（以前写 6000，超过 2000 的卡会在校验层被拒，接口却先放行）
export const SEED_MAX_CHARS = 2000;

/** 她现在有没有起点。 */
export async function seedStatus(root) {
  try {
    const { events } = await readEvents(root);
    const seed = events.find((event) => event?.type === 'seed');
    return {
      seeded: Boolean(seed),
      text: seed ? String(seed.text ?? '') : '',
      at: seed?.at ?? seed?.ts ?? null,
      count: events.length,
    };
  } catch {
    return { seeded: false, text: '', at: null, count: 0 };
  }
}

/**
 * 写入基础人格卡。已有起点时拒绝（不覆盖、不合并）。
 * @returns {{ok:boolean, reason?:string}}
 */
export async function applySeed(root, text) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: 'EMPTY' };
  if ([...body].length > SEED_MAX_CHARS) return { ok: false, reason: 'TOO_LONG' };

  const status = await seedStatus(root);
  if (status.seeded) return { ok: false, reason: 'ALREADY_SEEDED' };

  try {
    await appendEvent({ type: 'seed', text: body }, { day: 1, stage: 1, source: 'system' }, root);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'WRITE_FAILED:' + String(error?.message ?? error).slice(0, 80) };
  }
}
