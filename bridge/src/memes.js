import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TYPES = { '.gif': 1, '.png': 2, '.webp': 2, '.jpg': 2 };
const MAX_BYTES = 8 * 1024 * 1024;
const digest = (buffer) => createHash('md5').update(buffer).digest('hex');
const extension = (ext) => {
  const value = String(ext ?? '').toLowerCase();
  return value.startsWith('.') ? value : `.${value}`;
};

export function listLocalMemes(packsDir) {
  const result = [];
  function entries(dir) {
    try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  }
  function walk(dir, emotion, pack) {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, emotion, pack);
      else if (entry.isFile() && TYPES[path.extname(entry.name).toLowerCase()]) result.push({ file, emotion, pack });
    }
  }
  if (!packsDir) return result;
  for (const pack of entries(packsDir).filter((entry) => entry.isDirectory())) {
    const memes = path.join(packsDir, pack.name, 'memes');
    for (const emotion of entries(memes).filter((entry) => entry.isDirectory())) {
      walk(path.join(memes, emotion.name), emotion.name, pack.name);
    }
  }
  return result;
}

export function importToOutgoing({ file, buffer, ext, outgoingDir, md5, pythonPath } = {}) {
  let suffix = extension(ext ?? path.extname(file ?? ''));
  if (!TYPES[suffix]) throw new Error('Unsupported meme extension');
  let bytes = buffer !== undefined ? Buffer.from(buffer) : readFileSync(file);
  // 微信只认 GIF：webp/png 会被原生接口拒掉，这里先转
  if (suffix !== '.gif' && file && pythonPath) {
    const gif = toGif({ file, pythonPath });
    if (!gif) throw new Error('MEME_CONVERSION_FAILED');
    bytes = gif; suffix = '.gif';
  }
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Meme must be 1 byte to 8MB');
  const actual = digest(bytes);
  if (md5 && String(md5).toLowerCase() !== actual) throw new Error('Meme md5 mismatch');
  mkdirSync(outgoingDir, { recursive: true });
  const destination = path.join(outgoingDir, actual + suffix);
  writeFileSync(destination, bytes);
  const dimensions = suffix === '.gif' && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
    ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : {};
  return { md5: actual, path: destination, len: bytes.length, type: TYPES[suffix], ...dimensions };
}

export function pickMeme({ packsDir, emotion, random = Math.random } = {}) {
  const all = listLocalMemes(packsDir);
  const matches = all.filter((item) => item.emotion === emotion);
  const pool = matches.length ? matches : all;
  return pool.length ? pool[Math.floor(random() * pool.length) % pool.length] : null;
}

export async function fetchRemote({ manifestUrl, emotion, limit = 5, fetchImpl = globalThis.fetch, cacheDir } = {}) {
  const files = [];
  const count = Math.max(0, Math.floor(Number(limit) || 0));
  if (!count) return files;
  try {
    const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return files;
    const manifest = await response.json();
    const items = (Array.isArray(manifest?.items) ? manifest.items : []).filter((item) => {
      const parts = String(item.path ?? '').replaceAll('\\', '/').split('/');
      return (!emotion || (parts[0] === 'memes' && parts[1] === emotion)) && typeof item.url === 'string';
    }).slice(0, count);
    for (const item of items) {
      try {
        const url = new URL(item.url, manifestUrl);
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        const ext = extension(path.posix.extname(String(item.path ?? '')) || path.posix.extname(url.pathname));
        if (!TYPES[ext]) continue;
        const image = await fetchImpl(url.href, { signal: AbortSignal.timeout(15000) });
        if (!image.ok || Number(image.headers?.get?.('content-length')) > MAX_BYTES) continue;
        const bytes = Buffer.from(await image.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_BYTES) continue;
        mkdirSync(cacheDir, { recursive: true });
        const file = path.join(cacheDir, digest(bytes) + ext);
        writeFileSync(file, bytes);
        files.push(file);
      } catch { /* 单张失败不影响其他图片和回复。 */ }
    }
  } catch { /* 联网补图始终是可选的。 */ }
  return files;
}


/**
 * 微信原生表情只认 GIF：webp/png 会被 "Native sticker rejected" 拒掉（实测）。
 * 所以 dsh-meme 的图先转成 GIF 再发。用 WeChatAgent 自带的 Python + Pillow，
 * 不引任何 npm 依赖。
 */
import { spawnSync } from 'node:child_process';

const PY_SCRIPT = [
  'import sys, io',
  'from PIL import Image, ImageSequence, GifImagePlugin',
  'src = Image.open(io.BytesIO(sys.stdin.buffer.read()))',
  'frames = []',
  'durations = []',
  'count = 0',
  'for frame in ImageSequence.Iterator(src):',
  '    count += 1',
  '    if count > 60:',
  '        break',
  '    frames.append(frame.convert(\'RGB\').copy())',
  '    durations.append(int(src.info.get(\'duration\', 80) or 80))',
  'if len(frames) == 1:',
  '    frames.append(frames[0].copy())',
  '    durations.append(durations[0])',
  '# Encode full frames explicitly: save_all merges identical frames even with optimize=False.',
  'frames = [frame.quantize(colors=256) for frame in frames]',
  'buf = io.BytesIO()',
  'header, _ = GifImagePlugin.getheader(frames[0], info={"loop": 0})',
  'for block in header:',
  '    buf.write(block)',
  'for frame, duration in zip(frames, durations):',
  '    for block in GifImagePlugin.getdata(frame, duration=max(20, duration), disposal=2, include_color_table=True):',
  '        buf.write(block)',
  'buf.write(b";")',
  'buf.seek(0)',
  'check = Image.open(buf)',
  'assert check.n_frames >= 2 and check.size == src.size, "Invalid animated GIF"',
  'sys.stdout.buffer.write(buf.getvalue())',

].join('\n');

export function toGif({ file, pythonPath, timeoutMs = 8000 }) {
  if (!file || !pythonPath) return null;
  try {
    const input = readFileSync(file);
    const run = spawnSync(pythonPath, ['-c', PY_SCRIPT], { input, timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 });
    if (run.status !== 0 || !run.stdout || run.stdout.length === 0) return null;
    return run.stdout;
  } catch {
    return null;
  }
}
