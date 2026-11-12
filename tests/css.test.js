import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCssSubpaths, collectCssSubpaths } from '../strategies/css.js';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

async function createTempDir() {
  return mkdtemp(join(tmpdir(), '.temp_npm2esm-'));
}

// 写包文件并返回 context（files 为 { 相对路径: 内容 }）
async function setupPackage(dir, name, files, manifest = {}) {
  const packageDir = join(dir, 'node_modules', name);

  await mkdir(packageDir, { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const file = join(packageDir, rel);

    await mkdir(join(packageDir, rel, '..'), { recursive: true });
    await writeFile(file, content);
  }

  // package.json 必须总是存在：collectCssSubpaths 读不到清单会整体跳过收集
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }));  const outputPackageDir = join(dir, 'dist', name);

  await mkdir(outputPackageDir, { recursive: true });

  return {
    packageName: name,
    packageConfig: null,
    rootDir: dir,
    srcDirAbs: join(dir, 'node_modules'),
    packageDir,
    outputPackageDir,
    urlBase: '/lib/',
  };
}

// ---------------------------------------------------------------------------
// collectCssSubpaths：三来源收集（与 wta9 自动包 CSS 产出的真实路径对应）
// ---------------------------------------------------------------------------

test('style 字段收集', async () => {
  const dir = await createTempDir();

  try {
    const context = await setupPackage(dir, 'styled', {}, { style: './dist/ui.css' });

    assert.deepEqual(await collectCssSubpaths(context.packageName, context.srcDirAbs), [
      { subpath: 'dist/ui.css', fromConvention: false },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exports 收集 ./css subpath（含嵌套 condition）', async () => {
  const dir = await createTempDir();

  try {
    const context = await setupPackage(dir, 'exported', {}, {
      exports: {
        '.': './dist/index.js',
        './style.css': './dist/style.css',
        './dark.css': { import: './dist/dark.css', default: './dist/dark.css' },
        './data.json': './dist/data.json',
      },
    });

    const collected = await collectCssSubpaths(context.packageName, context.srcDirAbs);

    assert.deepEqual(
      [...collected.map((item) => item.subpath)].sort(),
      ['dark.css', 'style.css'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('约定兜底：dist 命名候选、dist 唯一 css、包根候选', async () => {
  const dir = await createTempDir();

  try {
    // 命名候选命中：dist/<base>.min.css
    const named = await setupPackage(dir, 'named', { 'dist/named.min.css': '.a{}\n' });

    assert.deepEqual(await collectCssSubpaths(named.packageName, named.srcDirAbs), [
      { subpath: 'dist/named.min.css', fromConvention: true },
    ]);

    // dist 下唯一 css 也符合
    const sole = await setupPackage(dir, 'sole', { 'dist/whatever-name.css': '.b{}\n' });

    assert.deepEqual(await collectCssSubpaths(sole.packageName, sole.srcDirAbs), [
      { subpath: 'dist/whatever-name.css', fromConvention: true },
    ]);

    // 无 dist：包根 index.css
    const rooted = await setupPackage(dir, 'rooted', { 'index.css': '.c{}\n' });

    assert.deepEqual(await collectCssSubpaths(rooted.packageName, rooted.srcDirAbs), [
      { subpath: 'index.css', fromConvention: true },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('清单已声明 css 时不做约定兜底，避免重复产出', async () => {
  const dir = await createTempDir();

  try {
    const context = await setupPackage(
      dir,
      'both',
      { 'dist/other.css': '.x{}\n' },
      { style: './dist/style.css' },
    );

    assert.deepEqual(await collectCssSubpaths(context.packageName, context.srcDirAbs), [
      { subpath: 'dist/style.css', fromConvention: false },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildCssSubpaths：min.css 直接复制、非 min 编译、失败仅记录不连坐
// ---------------------------------------------------------------------------

test('buildCssSubpaths：.min.css 复制、非 min 编译为 .min.css', async () => {
  const dir = await createTempDir();

  try {
    const context = await setupPackage(dir, 'csspkg', {
      'dist/style.css': '.box { color: red; }\n',
      // min.css 复制分支按 subpath 直取文件路径（不走 exports 解析），key 与路径需一致
      'pre.min.css': '.min{}\n',
    }, {
      style: './dist/style.css',
      exports: {
        // esbuild 对带 exports 的包做封闭解析：subpath 编译的映射必须存在
        './dist/style.css': './dist/style.css',
        './pre.min.css': './pre.min.css',
      },
    });

    const results = await buildCssSubpaths(context);

    // 两个 subpath 都成功
    assert.deepEqual(results.map((item) => item.success), [true, true]);

    // 非 min 的编译产物：内容保留且是压缩后的 css
    const compiled = await readFile(join(context.outputPackageDir, 'style.min.css'), 'utf8');

    assert.ok(compiled.includes('.box'));

    // 已是 min 的原样复制
    assert.equal(await readFile(join(context.outputPackageDir, 'pre.min.css'), 'utf8'), '.min{}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
