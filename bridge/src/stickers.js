// 表情包挑选：直接用 WeChatAgent 已经准备好的出站表情文件。
//
// 为什么不用 Reader 的 /api/v1/stickers：那个接口只返回 {id, receivedAt, origin}，
// 拿不到原生发送需要的 md5/productid/len/type/width/height，而 /api/v1/stickers/<id>
// 在本机是 404。出站目录里的文件名**就是 md5**，正好满足原生校验：
//   路径必须在 state/stickers/outgoing 下、stem === md5、大小 ≤8MB、扩展名合法。
//
// productid 与宽高留空/0：原生校验允许（wechatagent_hook.cpp:207-210）。

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const EXT_TYPE = { '.gif': 1, '.png': 2, '.jpg': 2, '.jpeg': 2, '.webp': 2, '.wxgf': 2 };

export function listStickers(dir) {
  try {
    return readdirSync(dir)
      .map((name) => {
        const ext = path.extname(name).toLowerCase();
        if (!(ext in EXT_TYPE)) return null;
        const stem = path.basename(name, ext);
        if (!/^[a-f0-9]{32}$/.test(stem)) return null;
        const full = path.join(dir, name);
        try {
          const size = statSync(full).size;
          if (!size || size > 8 * 1024 * 1024) return null;
          return { md5: stem, path: full, len: size, type: EXT_TYPE[ext], ext };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createStickerPicker({ dir, random = Math.random, keywords = [] } = {}) {
  if (!dir) throw new Error('createStickerPicker 需要 dir');
  let cache = null;
  let cachedAt = 0;

  function all() {
    const now = Date.now();
    if (cache && now - cachedAt < 60_000) return cache;
    cache = listStickers(dir);
    cachedAt = now;
    return cache;
  }

  return {
    count() {
      return all().length;
    },
    /** 随机挑一张；带关键词时优先按文件名/无关（文件名是 md5，没法按语义筛）。 */
    pick() {
      const list = all();
      if (!list.length) return null;
      void keywords;
      return list[Math.floor(random() * list.length) % list.length];
    },
  };
}
