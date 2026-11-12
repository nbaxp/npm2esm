import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import browserEsmStrategy from '../strategies/browser-esm.js';
import configuredStrategy from '../strategies/configured.js';
import esbuildStrategy from '../strategies/esbuild.js';
import { getPackageTasks } from '../utils.js';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

async function createTempDir() {
  return mkdtemp(join(tmpdir(), '.temp_npm2esm-'));
}

// 在临时 node_modules 下造一个最小包：files 为 { 相对路径: 内容 }
async function writeFakePackage(dir, name, files, manifest = {}) {
  const packageDir = join(dir, 'node_modules', name);

  await mkdir(packageDir, { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const file = join(packageDir, rel);

    await mkdir(join(packageDir, rel, '..'), { recursive: true });
    await writeFile(file, content);
  }

  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }));

  return packageDir;
}

function createContext(dir, packageName, packageConfig) {
  return {
    packageName,
    packageConfig,
    rootDir: dir,
    srcDirAbs: join(dir, 'node_modules'),
    packageDir: join(dir, 'node_modules', packageName),
    outputPackageDir: join(dir, 'dist', packageName),
    urlBase: '/lib/',
  };
}

// ---------------------------------------------------------------------------
// configured 策略（两个消费方的核心路径）
// ---------------------------------------------------------------------------

test('configured：esbuild + copy 数组任务按序执行并推断入口与前缀映射', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'test-ui', {
      'src/main.js': 'export const version = "1.0.0";\n',
      'dist/test-ui.css': '.test-ui { color: red; }\n',
      'dist/fonts/a.woff2': 'font-a\n',
      'dist/fonts/b.woff2': 'font-b\n',
    });

    await mkdir(join(dir, 'dist', 'test-ui'), { recursive: true });

    const context = createContext(dir, 'test-ui', [
      { from: 'src/main.js', to: 'index.min.js' },
      { copy: true, from: 'dist/test-ui.css', to: 'index.min.css' },
      { copy: true, from: 'dist/fonts/*.woff2', to: 'fonts' },
    ]);

    const result = await configuredStrategy.build(context);

    assert.equal(result.success, true);

    // esbuild 任务：产物存在且已压缩
    const bundle = await readFile(join(context.outputPackageDir, 'index.min.js'), 'utf8');

    assert.ok(bundle.includes('version'));
    assert.ok(!bundle.includes(' = '));

    // copy 任务：改名复制
    assert.equal(await readFile(join(context.outputPackageDir, 'index.min.css'), 'utf8'), '.test-ui { color: red; }\n');

    // copy 任务：glob 落入 to 目录
    assert.equal(await readFile(join(context.outputPackageDir, 'fonts', 'a.woff2'), 'utf8'), 'font-a\n');
    assert.equal(await readFile(join(context.outputPackageDir, 'fonts', 'b.woff2'), 'utf8'), 'font-b\n');

    // importmap：唯一 .min.js 入口 + 子目录产物触发的前缀映射
    assert.deepEqual(result.importMap, [
      { key: 'test-ui', value: '/lib/test-ui/index.min.js', dev: false },
      { key: 'test-ui/', value: '/lib/test-ui/', dev: false },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：importmap: true 显式入口优先于唯一 .min.js', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'test-ui', {
      'src/main.js': 'export const a = 1;\n',
      'src/full.js': 'export const b = 2;\n',
    });

    await mkdir(join(dir, 'dist', 'test-ui'), { recursive: true });

    const context = createContext(dir, 'test-ui', [
      { from: 'src/main.js', to: 'index.min.js' },
      { from: 'src/full.js', to: 'full.min.js', importmap: true },
    ]);

    const result = await configuredStrategy.build(context);

    assert.equal(result.importMap[0].value, '/lib/test-ui/full.min.js');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：多个 .min.js 无显式声明时取第一个；纯 copy 无入口时只有前缀映射', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'multi', {
      'src/a.js': 'export const a = 1;\n',
      'src/b.js': 'export const b = 2;\n',
    });

    await mkdir(join(dir, 'dist', 'multi'), { recursive: true });

    const multi = createContext(dir, 'multi', [
      { from: 'src/a.js', to: 'aaa.min.js' },
      { from: 'src/b.js', to: 'bbb.min.js' },
    ]);

    assert.equal(configuredStrategy.plan(multi)[0].value, '/lib/multi/aaa.min.js');

    await writeFakePackage(dir, 'mathjax', {
      'dist/fonts/size4.js': '// font\n',
    });

    const copyOnly = createContext(dir, 'mathjax', [{ copy: true, from: 'dist/fonts', to: 'fonts' }]);

    await mkdir(copyOnly.outputPackageDir, { recursive: true });

    const copyResult = await configuredStrategy.build(copyOnly);

    // 没有 .js 入口 → 无包名条目；产物落在子目录 → 只有前缀映射
    assert.deepEqual(copyResult.importMap, [{ key: 'mathjax/', value: '/lib/mathjax/', dev: false }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：esbuild 任务失败抛出，整包判失败', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'broken', {});

    await mkdir(join(dir, 'dist', 'broken'), { recursive: true });

    const context = createContext(dir, 'broken', [{ from: 'src/missing.js', to: 'index.min.js' }]);

    await assert.rejects(() => configuredStrategy.build(context), /构建失败|Could not resolve/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：glob 零匹配必须失败，不静默产出残缺包', async () => {
  const dir = await createTempDir();

  try {
    // fonts 目录存在但无 woff2 文件：包升级后文件消失的场景
    await writeFakePackage(dir, 'gone', { 'dist/fonts/keep.txt': 'x\n' });

    await mkdir(join(dir, 'dist', 'gone'), { recursive: true });

    const context = createContext(dir, 'gone', [{ copy: true, from: 'dist/fonts/*.woff2', to: 'fonts' }]);

    await assert.rejects(() => configuredStrategy.build(context), /glob 未匹配到文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：显式声明 external 时不做 peer 自动排除，peerDependencies 被内联', async () => {
  const dir = await createTempDir();

  try {
    // agg-pkg 依赖 peer-lib（声明为 peer）；peer-lib 是独立可构建的小包
    await writeFakePackage(dir, 'peer-lib', { 'index.js': 'export const v = 7;\n' }, { main: 'index.js' });
    await writeFakePackage(dir, 'agg-pkg', {
      'dist/index.js': 'import { v } from "peer-lib";\nexport const out = v;\n',
    }, { peerDependencies: { 'peer-lib': '*' } });

    await mkdir(join(dir, 'dist', 'agg-pkg'), { recursive: true });

    // 显式 external（含一个无关包）→ peer-lib 不被自动排除，内联进产物
    const inline = createContext(dir, 'agg-pkg', [
      { from: 'dist/index.js', to: 'index.min.js', external: ['vue'] },
    ]);

    const inlineResult = await configuredStrategy.build(inline);

    const inlineBundle = await readFile(join(inline.outputPackageDir, 'index.min.js'), 'utf8');

    assert.equal(inlineResult.success, true);
    assert.ok(inlineBundle.includes('7'));
    assert.ok(!inlineBundle.includes('from"peer-lib"') && !inlineBundle.includes('from "peer-lib"'));

    // 未声明 external → peer 自动排除生效，产物保留裸引用
    await writeFakePackage(dir, 'agg2', {
      'dist/index.js': 'import { v } from "peer-lib";\nexport const out = v;\n',
    }, { peerDependencies: { 'peer-lib': '*' } });

    await mkdir(join(dir, 'dist', 'agg2'), { recursive: true });

    const externalized = createContext(dir, 'agg2', [{ from: 'dist/index.js', to: 'index.min.js' }]);

    await configuredStrategy.build(externalized);

    const externalBundle = await readFile(join(externalized.outputPackageDir, 'index.min.js'), 'utf8');

    assert.match(externalBundle, /from\s*["']peer-lib["']/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('configured：esbuild 任务省略 from 时按 manifest 推导 ESM 入口', async () => {
  const dir = await createTempDir();

  try {
    const source = 'export const n = 42;\n';

    // 三种 exports 形态 + module 回退，都应推导出 dist/index.js
    const variants = [
      ['dot-import', { exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } } }],
      ['top-conditional', { exports: { import: './dist/index.js', require: './dist/index.cjs' } }],
      ['string', { exports: './dist/index.js' }],
      ['module-fallback', { module: './dist/index.js' }],
    ];

    for (const [name, manifest] of variants) {
      await writeFakePackage(dir, `entry-${name}`, { 'dist/index.js': source }, manifest);
      await mkdir(join(dir, 'dist', `entry-${name}`), { recursive: true });

      const result = await configuredStrategy.build(
        createContext(dir, `entry-${name}`, [{ to: 'index.min.js' }]),
      );
      const bundle = await readFile(join(dir, 'dist', `entry-${name}`, 'index.min.js'), 'utf8');

      assert.equal(result.success, true, name);
      assert.ok(bundle.includes('42'), name);
    }

    // exports/module/main 均不可用时给出明确报错
    await writeFakePackage(dir, 'entry-none', { 'dist/index.js': source }, {});
    await mkdir(join(dir, 'dist', 'entry-none'), { recursive: true });

    await assert.rejects(
      () => configuredStrategy.build(createContext(dir, 'entry-none', [{ to: 'index.min.js' }])),
      /无法从 package\.json 推导 ESM 入口/,
    );

    // 省略 from 与显式声明产物逐字节一致
    await writeFakePackage(
      dir,
      'entry-parity',
      { 'dist/index.js': source },
      { exports: { '.': { import: './dist/index.js' } } },
    );
    await mkdir(join(dir, 'dist', 'entry-parity'), { recursive: true });

    await configuredStrategy.build(createContext(dir, 'entry-parity', [{ to: 'auto.min.js' }]));
    const autoBundle = await readFile(join(dir, 'dist', 'entry-parity', 'auto.min.js'), 'utf8');

    await configuredStrategy.build(
      createContext(dir, 'entry-parity', [{ from: 'dist/index.js', to: 'explicit.min.js' }]),
    );
    const explicitBundle = await readFile(join(dir, 'dist', 'entry-parity', 'explicit.min.js'), 'utf8');

    assert.equal(autoBundle, explicitBundle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// browser-esm 策略（vue / vue-router 等自动包的路径）
// ---------------------------------------------------------------------------

test('browser-esm：normal+prod 双产物复制与 prod/dev 双条目', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'test-lib', {
      'dist/test-lib.esm-browser.js': 'export const v = 1;\n',
      'dist/test-lib.esm-browser.prod.js': 'export const v=1;\n',
    });

    await mkdir(join(dir, 'dist', 'test-lib'), { recursive: true });

    const context = createContext(dir, 'test-lib', null);

    const result = await browserEsmStrategy.build(context);

    assert.equal(result.success, true);

    // dist 已有 min 产物时原样复制，不重新压缩
    assert.equal(await readFile(join(context.outputPackageDir, 'index.js'), 'utf8'), 'export const v = 1;\n');
    assert.equal(await readFile(join(context.outputPackageDir, 'index.min.js'), 'utf8'), 'export const v=1;\n');

    assert.deepEqual(result.importMap, [
      { key: 'test-lib', value: '/lib/test-lib/index.min.js', dev: false },
      { key: 'test-lib', value: '/lib/test-lib/index.js', dev: true },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser-esm：只有 normal 产物时自动压缩出 index.min.js', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'only', {
      'dist/only.esm-browser.js': 'export const alpha = 1;\n',
    });

    await mkdir(join(dir, 'dist', 'only'), { recursive: true });

    const context = createContext(dir, 'only', null);

    const result = await browserEsmStrategy.build(context);

    assert.equal(result.success, true);

    const min = await readFile(join(context.outputPackageDir, 'index.min.js'), 'utf8');

    assert.ok(min.includes('alpha'));
    assert.ok(!min.includes(' = '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// esbuild 兜底策略（无 config、无 dist 产物的自动包）
// ---------------------------------------------------------------------------

test('esbuild 兜底：从包入口自动 bundle 并产出 prod 条目', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'auto-pkg', { 'index.js': 'export const n = 42;\n' }, { main: 'index.js' });

    await mkdir(join(dir, 'dist', 'auto-pkg'), { recursive: true });

    const context = createContext(dir, 'auto-pkg', null);

    const result = await esbuildStrategy.build(context);

    assert.equal(result.success, true);

    const bundle = await readFile(join(context.outputPackageDir, 'index.min.js'), 'utf8');

    assert.ok(bundle.includes('42'));
    assert.deepEqual(result.importMap, [{ key: 'auto-pkg', value: '/lib/auto-pkg/index.min.js', dev: false }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('esbuild 兜底：根包失败不抛出，返回失败结果供主流程汇总', async () => {
  const dir = await createTempDir();

  try {
    // 只有 package.json，无任何入口
    await writeFakePackage(dir, 'no-entry', {});

    await mkdir(join(dir, 'dist', 'no-entry'), { recursive: true });

    const context = createContext(dir, 'no-entry', null);

    const result = await esbuildStrategy.build(context);

    assert.equal(result.success, false);
    assert.ok(result.results[0].error instanceof Error);
    assert.equal(result.importMap, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// utils：任务配置规范化
// ---------------------------------------------------------------------------

test('getPackageTasks：字符串/对象/数组统一规范化为任务列表', () => {
  assert.deepEqual(getPackageTasks('src/main.js'), [{ from: 'src/main.js' }]);
  assert.deepEqual(getPackageTasks({ from: 'a.js', to: 'b.js' }), [{ from: 'a.js', to: 'b.js' }]);
  assert.deepEqual(getPackageTasks(['x.js', { from: 'a', copy: true }]), [
    { from: 'x.js' },
    { from: 'a', copy: true },
  ]);
  assert.deepEqual(getPackageTasks(undefined), []);
});
