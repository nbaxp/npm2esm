import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { copyPackageFile } from '../tasks/copy.js';
import { buildFailureError, runEsbuildTask } from '../tasks/esbuild.js';

// ---------------------------------------------------------------------------
// CSS subpath 收集
// ---------------------------------------------------------------------------

function collectCssFromStyle(manifest) {
  if (typeof manifest?.style !== 'string') return [];

  const rel = manifest.style.replace(/^\.\//, '').trim();

  if (!rel || !rel.toLowerCase().endsWith('.css')) return [];

  return [rel];
}

function collectCssFromExports(exportsField) {
  const result = new Set();

  function visit(value, key = null) {
    if (key?.startsWith('./') && !key.includes('*') && key.toLowerCase().endsWith('.css')) {
      result.add(key.slice(2));
    }

    if (typeof value === 'string' || value == null) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);

      return;
    }

    if (typeof value !== 'object') return;

    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey.startsWith('./')) {
        visit(childValue, childKey);
      } else {
        visit(childValue, key);
      }
    }
  }

  visit(exportsField);

  return [...result];
}

// dist/ 存在则只查 dist，否则查包根目录；命中 包同名.css 或 index.css 即收集
async function collectCssFromConvention(packageName, srcDirAbs) {
  const base = basename(packageName);
  const packageDir = resolve(srcDirAbs, packageName);

  let hasDist = false;

  try {
    hasDist = (await stat(resolve(packageDir, 'dist'))).isDirectory();
  } catch {
    // dist 不存在：保持 false
  }

  const dirs = hasDist ? ['dist'] : [''];

  for (const dir of dirs) {
    for (const name of [`${base}.min.css`, `${base}.css`, 'index.min.css', 'index.css']) {
      const rel = dir ? `${dir}/${name}` : name;

      try {
        if ((await stat(resolve(packageDir, rel))).isFile()) {
          return [rel];
        }
      } catch {
        // 不存在，继续
      }
    }

    // 命名候选未命中：dist 下唯一 .css 文件也符合
    if (dir === 'dist') {
      try {
        const cssFiles = (await readdir(resolve(packageDir, 'dist'))).filter((name) =>
          name.toLowerCase().endsWith('.css'),
        );

        if (cssFiles.length === 1) {
          return [`dist/${cssFiles[0]}`];
        }
      } catch {
        // 读取失败，忽略
      }
    }
  }

  return [];
}

export async function collectCssSubpaths(packageName, srcDirAbs) {
  let manifest;

  try {
    manifest = JSON.parse(await readFile(resolve(srcDirAbs, packageName, 'package.json'), 'utf8'));
  } catch {
    return [];
  }

  const all = new Map();

  for (const rel of collectCssFromStyle(manifest)) {
    all.set(rel, false);
  }

  for (const rel of collectCssFromExports(manifest.exports)) {
    all.set(rel, false);
  }

  // 约定收集仅作兜底：清单已声明 CSS 时跳过，避免同一文件重复产出
  if (all.size === 0) {
    for (const rel of await collectCssFromConvention(packageName, srcDirAbs)) {
      all.set(rel, true);
    }
  }

  // [{ subpath, fromConvention }]
  return [...all].map(([subpath, fromConvention]) => ({
    subpath,
    fromConvention,
  }));
}

// ---------------------------------------------------------------------------
// CSS subpath 构建（browser-esm / esbuild 自动策略共用）
// ---------------------------------------------------------------------------

async function buildCssSubpath(
  context,
  {
    subpath,
    outputName,
    entry, // 可选：绝对路径入口（约定收集用），缺省用包 specifier
  },
) {
  const { packageName, rootDir, srcDirAbs, outputPackageDir } = context;
  const specifier = `${packageName}/${subpath}`;
  const output = resolve(outputPackageDir, outputName);

  console.log(`\n🔹 构建 CSS subpath ${specifier}`);

  try {
    await runEsbuildTask({
      rootDir,
      srcDirAbs,
      entryPoints: [entry ?? specifier],
      outfile: output,
      options: {
        minify: true,
        mainFields: ['browser', 'style', 'main'],
        conditions: ['browser', 'style', 'default'],
      },
    });

    console.log(`✅ ${specifier} 构建完成`);

    return {
      success: true,
      kind: 'subpath',
      specifier,
    };
  } catch (error) {
    const failure = buildFailureError(specifier, error);

    console.warn(`\n⚠️  跳过 ${specifier}\n   原因：${failure.message}`);

    return {
      success: false,
      kind: 'subpath',
      specifier,
      error: failure,
    };
  }
}

// 构建全部 CSS subpath，返回每项结果（失败仅记录，不影响包整体成败）
export async function buildCssSubpaths(context) {
  const { packageName, srcDirAbs, outputPackageDir } = context;

  const results = [];

  const cssSubpaths = await collectCssSubpaths(packageName, srcDirAbs);

  for (const { subpath, fromConvention } of cssSubpaths) {
    const outputName = fromConvention
      ? 'index.min.css'
      : subpath.replace(/^dist\//i, '').replace(/\.css$/i, '.min.css');

    // 已是压缩产物（.min.css）直接复制，不重复编译；失败与编译分支一致：仅记录，不影响包整体
    if (subpath.toLowerCase().endsWith('.min.css')) {
      const specifier = `${packageName}/${subpath}`;

      try {
        await copyPackageFile(
          resolve(srcDirAbs, packageName, subpath),
          resolve(outputPackageDir, outputName),
        );

        results.push({ success: true, kind: 'subpath', specifier });
      } catch (error) {
        const failure = buildFailureError(specifier, error);

        console.warn(`\n⚠️  跳过 ${specifier}\n   原因：${failure.message}`);

        results.push({
          success: false,
          kind: 'subpath',
          specifier,
          error: failure,
        });
      }

      continue;
    }

    results.push(
      await buildCssSubpath(context, {
        subpath,
        outputName,
        entry: fromConvention ? resolve(srcDirAbs, packageName, subpath) : undefined,
      }),
    );
  }

  return results;
}
