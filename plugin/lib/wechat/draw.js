import path from 'node:path';
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { looksLikeRewriting, looksLikeSecret } from '../guard.js';

const exec = promisify(execFile);
export function drawIntent(text, batch) {
  const input = (batch?.rows ?? []).filter(r => !r.outgoing).map(r => String(r.text ?? '')).join('\n');
  const promise = /我(?:来|给你|帮你)?画|画好了/.test(text) && !/(?:不|没|无法|不能).{0,4}画/.test(text);
  const request = /画(?:一[个张幅]|张图|个|一张)/.test(input) && !/(?:别|不要|不用)画/.test(input);
  // 追问进度也算：她一答应就会一直编下去，追问等于逼她兑现
  const asking = /画.{0,6}(完|好)(了)?[吗嘛么没]|画到哪|画得怎么样|画好了没/.test(input);
  if (!promise && !request && !asking) return null;
  return `请实际绘制一张微信表情包。对象和要求参考她的回复：${text}\n用户原话：${input}\n只绘制相关对象，简洁，透明背景，无水印。`;
}
export function imageFile(result) {
  if (result?.isError) throw new Error('image_generate 返回错误: ' + JSON.stringify(result.content));
  const seen = new Set();
  function scan(value) {
    if (!value || seen.has(value)) return null;
    if (typeof value === 'string') {
      if (/\.(png|webp|gif|jpe?g)$/i.test(value) && existsSync(value)) return path.resolve(value);
      for (const m of value.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\r\n"<>]*?\.(?:png|webp|gif|jpe?g)/gi)) if (existsSync(m[0])) return path.resolve(m[0]);
      try { return scan(JSON.parse(value)); } catch { return null; }
    }
    if (typeof value !== 'object') return null;
    seen.add(value);
    for (const child of Object.values(value)) { const found = scan(child); if (found) return found; }
    return null;
  }
  const file = scan(result);
  if (!file) throw new Error('image_generate 未返回存在的图片文件');
  return file;
}
export async function convertDraw(file, { env = process.env, execute = exec } = {}) {
  const base = path.join(env.LOCALAPPDATA, 'WeChatFish');
  const runtimes = path.join(base, 'runtimes');
  const installed = path.join(base, 'runtime', 'python', 'python.exe');
  const python = existsSync(installed) ? installed : (existsSync(runtimes) ? readdirSync(runtimes).sort().reverse().map(n => path.join(runtimes, n, 'python', 'python.exe')).find(existsSync) : null);
  if (!python) throw new Error('找不到 WeChatFish Python/Pillow');
  const out = path.join(base, 'workspace', 'state', 'stickers', 'outgoing');
  mkdirSync(out, { recursive: true });
  const target = path.join(out, 'draw-' + randomUUID() + '.gif');
  const script = "from PIL import Image\nimport sys\nim=Image.open(sys.argv[1]).convert('RGBA')\nim.thumbnail((240,240))\nbg=Image.new('RGBA', im.size, (255,255,255,255))\nbg.alpha_composite(im)\nbg.convert('RGB').save(sys.argv[2], 'GIF')";
  await execute(python, ['-c', script, file, target], { timeout: 30000, windowsHide: true });
  const bytes = readFileSync(target);
  if (!/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) || bytes.length > 1024 * 1024 || bytes.length < 14) throw new Error('生成 GIF 校验失败');
  return target;
}
export function makeDraw(ctx, { log = console.log, convert = convertDraw } = {}) {
  return async prompt => {
    log('[draw] 开始');
    try {
      if (looksLikeRewriting(prompt).hit || looksLikeSecret(prompt).hit) throw new Error('画图提示被 guard 拦截');
      const tool = ctx?.get?.('tools')?.get?.('image_generate');
      if (!tool?.execute) throw new Error('宿主未注册 image_generate');
      // 生成请求偶发 fetch failed（代理抖动）：重试两次
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await tool.execute({ prompt, size: '1024x1024' }, { signal: AbortSignal.timeout(21000) });
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          console.log('[draw] 重试 ' + (attempt + 1) + ': ' + (e && e.message));
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      const file = await convert(imageFile(result));
      log(`[draw] 完成 ${file} ${statSync(file).size} 字节`);
      return file;
    } catch (error) {
      log('[draw] 失败: ' + String(error?.message ?? error));
      throw error;
    }
  };
}
