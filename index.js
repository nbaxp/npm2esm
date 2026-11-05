#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './build.js';
import { STRATEGIES } from './strategies/index.js';

export const USAGE = `npm2esm —— 把 npm 依赖预构建成浏览器可 import 的 ESM 产物

用法：
  npm2esm [workspace] [package...] [--clear] [--config <path>]

参数：
  workspace        工作区目录（相对当前目录），默认当前目录
  package...       只构建指定包（位置参数是强制构建目标，不在 dependencies 中也构建）
  --clear          先清空整个 lib 再构建（指定包名时也只重建这些包）
  --config <path>  指定 config 文件路径（相对当前目录），优先于 NPM2ESM_CONFIG
  --help, -h       显示本帮助

环境变量：
  NPM2ESM_CONFIG        自定义 config 路径（默认依次查找 <workspace>/npm2esm.config.js、<workspace>/npm2esm/config.js）
  NPM2ESM_CONCURRENCY   构建并发数（默认 4）

示例：
  npm2esm .
  npm2esm . lodash
  npm2esm . --clear
  npm2esm . --config ./npm2esm/config.js
`;

const FLAGS = new Set(['--clear', '--help', '-h']);
const VALUE_FLAGS = new Set(['--config']);

export function parseArgs(argv) {
  const flags = new Set();
  const positional = [];

  let configPath;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    // "--" 之后的内容一律按位置参数处理（npm run xxx -- --clear 场景）
    if (passthrough) {
      positional.push(arg);

      continue;
    }

    if (arg === '--') {
      passthrough = true;

      continue;
    }

    // --config 支持 --config <path> 与 --config=<path>
    const [name, inlineValue] = arg.startsWith('--config=') ? ['--config', arg.slice('--config='.length)] : [arg];

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (inlineValue === undefined) index += 1;

      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new Error('--config 需要一个文件路径');
      }

      configPath = value;

      continue;
    }

    // 未知选项直接报错，避免 --clea 这类笔误被当成包名/工作区名静默吞掉
    if (arg.startsWith('-') && arg !== '-') {
      if (!FLAGS.has(arg)) {
        throw new Error(`未知参数：${arg}（可用：--clear、--config、--help）`);
      }

      flags.add(arg);

      continue;
    }

    positional.push(arg);
  }

  return {
    clearOutput: flags.has('--clear'),
    configPath,
    help: flags.has('--help') || flags.has('-h'),
    positional,
  };
}

export async function main(argv) {
  const { clearOutput, configPath: configOption, help, positional } = parseArgs(argv);

  if (help) {
    console.log(USAGE);

    return;
  }

  // 工具独立于工作区，默认使用当前目录
  const target = positional[0] || process.cwd();

  const only = positional.slice(1);

  // --clear 优先于包名：整目录清空后只重建指定包，提示一句避免以为其它包还在
  if (clearOutput && only.length > 0) {
    console.warn(
      `⚠️  --clear 会清空整个 lib，之后只重建指定包（${only.join(', ')}），其它包目录不会恢复`,
    );
  }

  await run(target, only, {
    clearOutput,
    configPath: configOption,
    strategies: STRATEGIES,
  });
}

// 仅作为 CLI 直接执行时启动；被 import（测试）时不跑主流程
const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  // 解析错误一并走这里：未知参数不再被当成包名
  main(process.argv.slice(2)).catch((error) => {
    console.error('\n❌ npm2esm 构建失败');
    console.error(error?.stack ?? error?.message ?? error);
    process.exitCode = 1;
  });
}
