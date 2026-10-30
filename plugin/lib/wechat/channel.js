/**
 * channel.js —— 把微信接进 dsh-fish 的插件生命周期
 *
 * 三个约束（来自 AGENTS.md，不能破坏）：
 *   1. 不新增 npm 依赖 —— 宿主 LLM 包用**动态解析**，拿不到就降级，不让插件加载失败。
 *   2. 不新增人格设置入口 —— 微信侧只配置「端口 / 令牌 / 模型 / 字数」，没有性格参数。
 *   3. 事件只追加 —— 她的记忆仍然只有 events.jsonl 一个写入口。
 *
 * 为什么不用 `import '@deepseek-ai/dsh-llm'`：
 *   宿主的包被打进 app.asar，磁盘上没有可解析的 node_modules；而本插件是 link 安装，
 *   从仓库目录往上找不到它。实测报 `Cannot find package`。
 *   所以按候选路径找：环境变量 → 宿主 asar 解包目录 → 已知的随包副本。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWechatServer } from './server.js';
import { runWechatTurn } from './turn.js';
import { makeDraw } from './draw.js';
import { readEvents } from '../store.js';
import { deriveSelf } from '../derive.js';
import { imageBlocks } from './images.js';
import { findWeChatAgentHome } from './roots.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path2 from 'node:path';

const require_append = appendFileSync;
const require_path = path2;
function require_root() {
  try { mkdirSync(path2.join(homedir(), '.dsh-fish', 'logs'), { recursive: true }); } catch {}
  return path2.join(homedir(), '.dsh-fish');
}

const DEFAULT_PORT = 11231;

/** 候选位置，按顺序试。 */
export function llmCandidates({ env = process.env, resourcesPath = process.resourcesPath } = {}) {
  const list = [];
  list.push('@deepseek-ai/dsh-llm');
  if (env?.DSH_FISH_LLM) list.push(env.DSH_FISH_LLM);
  if (resourcesPath) {
    list.push(path.join(resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'));
    list.push(path.join(resourcesPath, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'));
  }
  // 已知的随包副本（WeChatAgent 的桥接插件自带一份）
  const wechatRoot = findWeChatAgentHome({ env });
  if (wechatRoot) list.push(path.join(wechatRoot, 'packages', 'dsh-social-bridge-plugin', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'));
  return list.filter(Boolean);
}

async function loadLlmModule(opts) {
  const failures = [];
  for (const spec of llmCandidates(opts)) {
    try {
      const target = spec.startsWith('@') || spec.startsWith('file:') ? spec : pathToFileURL(spec).href;
      const mod = await import(target);
      if (typeof mod?.createUserMessage === 'function' && typeof mod?.BlockAssembler === 'function') return mod;
      failures.push(spec + ': 缺少导出');
    } catch (error) {
      failures.push(spec + ': ' + String(error?.message ?? error).slice(0, 80));
    }
  }
  throw new Error('找不到 @deepseek-ai/dsh-llm（可设置 DSH_FISH_LLM 指向 lib/index.js）\n' + failures.join('\n'));
}

/**
 * 用宿主模型生成一段文本。拿不到宿主能力就抛出，由上层退化成沉默。
 */
export async function makeGenerate(ctx, { provider, model, maxTokens = 600, timeoutMs = 30000, loader = loadLlmModule, llmService } = {}) {
  const mod = await loader();
  // 某些宿主的 get 对未注册服务会抛错；仍应尝试旧版属性 API。
  let llm = llmService;
  if (!llm) {
    try { llm = ctx?.get?.('llm'); } catch { /* 尝试属性 API */ }
    if (!llm?.stream) llm = ctx?.llm;
  }
  if (!llm?.stream) throw new Error('宿主没有 llm.stream');
  const { createUserMessage, BlockAssembler } = mod;

  return async function generate(prompt, { batch } = {}) {
    try {
      const rows = Array.isArray(batch?.rows) ? batch.rows : [];
      const withImg = rows.filter(r => r && (r.image || r.imageId)).length;
      require_append(require_path.join(require_root(), 'logs', 'wechat-image.log'), new Date().toISOString() + ' generate 收到 batch: rows=' + rows.length + ' 带图=' + withImg + ' key=' + (batch && batch.key) + '\n');
    } catch {}
    const images = await imageBlocks({ ctx, batch, provider, model, log: (message) => {
      try {
        const line = new Date().toISOString() + ' ' + message + '\n';
        require_append(require_path.join(require_root(), 'logs', 'wechat-image.log'), line);
      } catch {
        /* 诊断写不进去不影响识图 */
      }
    } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: prompt }, ...images],
        source: { kind: 'wechat-social-bridge', form: 'fish-wechat-turn' },
      });
      const assembler = new BlockAssembler();
      for await (const chunk of llm.stream({
        provider,
        model,
        sessionId: 'fish-wechat-' + Date.now().toString(36),
        messages: [message],
        tools: [],
        maxTokens,
        signal: controller.signal,
      })) {
        assembler.push(chunk);
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 4000) break;
      }
      const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : [];
      return blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('');
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 文件配置为默认值；宿主 apply 配置显式提供的字段优先（不写回磁盘）。 */
export function resolveWechatConfig(config = {}, baseConfig = {}) {
  return { ...config, wechat: { ...config?.wechat, ...baseConfig?.wechat } };
}

/** 启动微信通道。直接调用与插件生命周期调用都不能静默失败。 */
export async function startWechatChannel(options = {}) {
  try {
    return await startChannel(options);
  } catch (error) {
    options.log?.('[wechat] 通道启动失败：' + String(error?.message ?? error));
    throw error;
  }
}

async function startChannel({ ctx, root, config = {}, log = () => {}, generate: injectedGenerate } = {}) {
  const cfg = config?.wechat ?? {};
  if (cfg.enabled !== true) {
    log('[wechat] 通道未启用：wechat.enabled 不是 true（请检查插件配置或数据目录 config.json）');
    return { dispose: async () => {}, status: () => ({ enabled: false, why: 'disabled' }) };
  }

  const port = Number.isSafeInteger(cfg.port) ? cfg.port : DEFAULT_PORT;
  const token = String(cfg.token ?? '').trim();
  if (!token || token.length < 16) {
    log('[wechat] 未配置 wechat.token（至少 16 字符），通道不启动');
    return { dispose: async () => {}, status: () => ({ enabled: false, why: 'no_token' }) };
  }

  const generate = injectedGenerate ?? (await makeGenerate(ctx, {
    provider: cfg.provider || 'deepseek-account',
    model: cfg.model || 'deepseek-flash',
    maxTokens: cfg.maxTokens ?? 600,
  }));

  let day = 1;
  try {
    const { events } = await readEvents(root);
    day = deriveSelf(events).day;
  } catch {
    /* 读不到就当第 1 天 */
  }

  const server = createWechatServer({
    token,
    port,
    log,
    ctx,
    provider: cfg.provider || 'deepseek-account',
    model: cfg.model || 'deepseek-flash',
    // 把表情频率、群聊配额等配置传进去，否则 stickerDue / groupQuota 读不到就永远按默认值
    runTurn: (batch) => runWechatTurn({ root, batch, generate, draw: makeDraw(ctx, { log }), log, maxChars: cfg.maxReplyChars ?? 300, config: { stickers: cfg.stickers ?? {}, wechat: cfg } }),
    status: () => ({ enabled: true, day }),
  });

  const address = await server.listen();
  log(`[wechat] 通道已监听 127.0.0.1:${address.port}`);

  return {
    dispose: () => server.dispose(),
    status: () => ({ enabled: true, port: address.port }),
  };
}
