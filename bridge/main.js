// 入口：读配置 → 起桥接 → 优雅退出。
// 配置里没有任何「怎么回」的东西，只有「连哪里、谁能说话、发多快」。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBridge } from './src/index.js';

// 用绝对路径：桥接要靠它监听配置变化，热更新允许名单
const configFile = path.resolve(process.argv[2] ?? 'config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));

for (const key of ['reader', 'hook', 'fish']) {
  if (!config?.[key]?.baseUrl) throw new Error(`配置缺少 ${key}.baseUrl`);
}
if (!Array.isArray(config.whitelist) || !config.whitelist.length) {
  throw new Error('配置缺少 whitelist（不允许空，空等于对所有人沉默）');
}

// 进程级兜底：宁可丢一轮回复，也不能整个桥接静默消失
process.on('unhandledRejection', (error) => {
  console.log(new Date().toISOString(), '[fatal-guard] unhandledRejection: ' + (error?.stack ?? error));
});
process.on('uncaughtException', (error) => {
  console.log(new Date().toISOString(), '[fatal-guard] uncaughtException: ' + (error?.stack ?? error));
});

// 把配置文件路径交给桥接，它要监听文件变化热更新允许名单
  config.__configPath = configFile;
const bridge = createBridge({ config, log: (line) => console.log(new Date().toISOString(), line) });
bridge.start();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log('stopping...');
    await bridge.stop();
    process.exit(0);
  });
}
