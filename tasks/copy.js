import { copyFileSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { isWithinDirectory } from '../utils.js';

// copy 任务（{ copy: true, from, to }）：from 相对包目录，to 相对包输出目录
//   { from: "dist/a.css", to: "a.min.css" }              改名复制
//   { from: "picker.js" }                                 同名复制（省略 to）
//   { from: "input" }                                     目录递归（同名落入输出）
//   { from: "dist/*.{worker.js,wasm}", to: "." }          glob 拍平到包根
//   { from: "i18n/{en,zh_CN}.js" }                        glob 省略 to，按源目录结构落入 i18n/

// stat 无法判定（不存在或出错）时返回 false；源路径不存在的错误由后续复制操作负责抛出
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// glob 仅支持 * 与 {a,b}（单层不递归）
const isGlobPattern = (from) => from.includes('*') || /\{[^}]+\}/.test(from);

/** 生成 glob 匹配函数，支持 * 与 {a,b}（任意位置，单层不递归） */
function makeMatcher(pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^$()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(
          /\{([^}]+)\}/g,
          (_, names) =>
            '(' +
            names
              .split(',')
              .map((s) => s.trim())
              .join('|') +
            ')',
        ) +
      '$',
  );

  return (name) => re.test(name);
}

function copyOne(from, to, packageDir, outputPackageDir) {
  const src = resolve(packageDir, from);
  const dest = resolve(outputPackageDir, to);

  // 落入包根用 "."，不接受空串
  if (to === '') {
    throw new Error(`非法的 copy 目标：to 不能为空，落入包输出根目录请用 "."`);
  }

  // to 语义为"相对包输出目录"，不得用 ../ 跳出
  if (!isWithinDirectory(outputPackageDir, dest)) {
    throw new Error(`非法的 copy 目标（跳出包输出目录）：${to}`);
  }

  // glob：扫描 from 所在目录逐个匹配，dest 必为目录
  if (isGlobPattern(from)) {
    const fromDir = dirname(src);
    const match = makeMatcher(basename(src));

    const names = readdirSync(fromDir).filter(match);

    // 零匹配必须失败：包升级后文件消失时不能静默产出残缺包
    if (names.length === 0) {
      throw new Error(`glob 未匹配到文件：${from}`);
    }

    // 确认有匹配后再建目标目录，避免源目录不存在时留下空目录
    mkdirSync(dest, { recursive: true });

    for (const name of names) {
      const s = join(fromDir, name);
      const d = join(dest, name);

      if (isDir(s)) {
        cpSync(s, d, { recursive: true });
      } else {
        copyFileSync(s, d);
      }
    }

    return;
  }

  // to 显式为目录（"."、以 / 结尾）或 dest 已存在为目录 → 保留原文件名落入其中；
  // 否则 dest 即目标文件
  const target = to === '.' || to.endsWith('/') || isDir(dest) ? join(dest, basename(src)) : dest;

  if (isDir(src)) {
    cpSync(src, target, { recursive: true });
  } else {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
  }
}

// 结构化复制任务（单个）
export async function runCopyTask(context, task) {
  const { packageName, packageDir, outputPackageDir } = context;
  const { from, to: toRel } = task;

  if (typeof from !== 'string' || from === '') {
    throw new Error(`${packageName} copy 任务的 from 必须是非空字符串`);
  }

  if (toRel !== undefined && typeof toRel !== 'string') {
    throw new Error(`${packageName} copy 任务的 to 必须是字符串`);
  }

  // 省略 to：普通复制同名同相对路径；glob 默认沿用源文件所在目录（按结构落入输出）
  const to = toRel ?? (isGlobPattern(from) ? dirname(from) : from);

  console.log(`📦 copy: ${packageName}/${from} → ${to}`);

  copyOne(from, to, packageDir, outputPackageDir);
}

// 自动策略用：单文件复制（自动建父目录）+ 日志
export async function copyPackageFile(input, output) {
  mkdirSync(dirname(output), { recursive: true });

  console.log(`      copy:   ${input}`);
  console.log(`         -> ${output}`);

  copyFileSync(input, output);
}
