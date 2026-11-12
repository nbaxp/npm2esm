import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import esbuild from 'esbuild';

const { build, transform } = esbuild;

// ---------------------------------------------------------------------------
// 文件压缩（复制场景用）
// ---------------------------------------------------------------------------

async function minifyJavaScriptFile({ input, output }) {
  const contents = await readFile(input, 'utf8');

  const result = await transform(contents, {
    loader: 'js',
    format: 'esm',
    minify: true,
  });

  await mkdir(dirname(output), {
    recursive: true,
  });

  await writeFile(output, result.code);
}

// 自动策略用：压缩单文件 + 日志
export async function minifyPackageFile(input, output) {
  console.log(`      minify: ${input}`);
  console.log(`         -> ${output}`);

  await minifyJavaScriptFile({ input, output });
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export function formatEsbuildErrors(error) {
  if (!error?.errors || error.errors.length === 0) {
    return error?.message ?? String(error);
  }

  return error.errors
    .map((item) => {
      const text = item.text ?? '未知错误';

      const loc = item.location;

      if (!loc) return text;

      return `${text} (${loc.file ?? 'unknown'}:${loc.line}:${loc.column})`;
    })
    .join('\n');
}

export function buildFailureError(specifier, error) {
  return new Error([`入口 "${specifier}" 构建失败：`, formatEsbuildErrors(error)].join('\n'));
}

// ---------------------------------------------------------------------------
// 通用 esbuild 任务：单份直写 outfile（minify 由 options 控制），
// 伴随 css 由 esbuild 自动跟随 outfile 命名
// ---------------------------------------------------------------------------

function findEntryPoint(result) {
  const inputs = result.metafile?.inputs ?? {};

  const imported = new Set();

  for (const item of Object.values(inputs)) {
    for (const imp of item.imports ?? []) {
      imported.add(imp.path);
    }
  }

  for (const [path] of Object.entries(inputs)) {
    if (!imported.has(path)) return path;
  }

  return null;
}

function getPackageNameFromEntry(entry) {
  if (typeof entry !== 'string') return null;

  const normalized = entry.replace(/\\/g, '/');

  // configured 任务传绝对路径，取 node_modules 之后的部分
  const marker = normalized.lastIndexOf('node_modules/');
  const specifier = marker >= 0 ? normalized.slice(marker + 'node_modules/'.length) : normalized;

  // 本地相对路径（如 ../../entries/shiki/index.js）无包名
  if (specifier.startsWith('./') || specifier.startsWith('../')) return null;

  const parts = specifier.split('/');

  if (parts[0].startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  return parts[0] || null;
}

async function getPeerExternals(srcDirAbs, entryPoints) {
  const packageNames = new Set();

  for (const entry of entryPoints) {
    const name = getPackageNameFromEntry(entry);

    if (name) packageNames.add(name);
  }

  const result = [];

  for (const name of packageNames) {
    try {
      const manifest = JSON.parse(await readFile(resolve(srcDirAbs, name, 'package.json'), 'utf8'));

      for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
        result.push(dep, `${dep}/*`);
      }
    } catch {
      // 无清单或解析失败：不自动排除
    }
  }

  return result;
}

export async function runEsbuildTask({ rootDir, srcDirAbs, entryPoints, outfile, options = {} }) {
  // 入口包 peerDependencies 自动排除（包名 + 子路径通配）。
  // 任务显式声明了 external 时完全以声明为准，不做推断——
  // 用于"聚合打包"场景：需要内联入口包的 peerDependencies（如 Tiptap 栈），
  // 共享依赖由调用方在 external 里显式列出。
  const peerExternals = options.external?.length > 0 ? [] : await getPeerExternals(srcDirAbs, entryPoints);

  const external = [...new Set([...(options.external ?? []), ...peerExternals])];

  const result = await build({
    absWorkingDir: rootDir,
    platform: 'browser',
    bundle: true,
    nodePaths: [srcDirAbs],
    metafile: true,
    ...options,
    entryPoints,
    outfile,
    external,
  });

  return {
    success: true,
    entryPoint: findEntryPoint(result),
  };
}
