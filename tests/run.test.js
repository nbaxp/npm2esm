import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../build.js';
import { STRATEGIES } from '../strategies/index.js';

// ---------------------------------------------------------------------------
// fixture：临时工作区（package.json + npm2esm.config.js + 假依赖包）
// ---------------------------------------------------------------------------

async function createTempDir() {
  return mkdtemp(join(tmpdir(), '.temp_npm2esm-'));
}

async function writeFakePackage(dir, name, files, manifest = {}) {
  const packageDir = join(dir, 'node_modules', name);

  await mkdir(packageDir, { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const file = join(packageDir, rel);

    await mkdir(join(packageDir, rel, '..'), { recursive: true });
    await writeFile(file, content);
  }

  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }));
}

async function writeWorkspace(dir, { dependencies, config }) {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'ws', private: true, dependencies }));
  await writeFile(join(dir, 'npm2esm.config.js'), `export default ${JSON.stringify(config)};\n`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

test('run 端到端：config 包与自动包全量构建，importmap 注入条目与版本号', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'pkg-a', { 'index.js': 'export const a = 1;\n' }, { main: 'index.js' });
    await writeFakePackage(dir, 'pkg-b', {
      'src/main.js': 'export const b = 2;\n',
      'assets/logo.txt': 'logo\n',
    });

    await writeWorkspace(dir, {
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
      config: {
        output: 'dist',
        lib: 'lib',
        packages: {
          'pkg-b': [
            { from: 'src/main.js', to: 'index.min.js' },
            { copy: true, from: 'assets/logo.txt', to: 'logo.txt' },
          ],
        },
      },
    });

    await run(dir, [], { strategies: STRATEGIES });

    // 自动包产物
    assert.ok(existsSync(join(dir, 'dist', 'lib', 'pkg-a', 'index.min.js')));

    // config 包产物（esbuild 任务 + copy 任务）
    assert.ok(existsSync(join(dir, 'dist', 'lib', 'pkg-b', 'index.min.js')));
    assert.equal(await readFile(join(dir, 'dist', 'lib', 'pkg-b', 'logo.txt'), 'utf8'), 'logo\n');

    // importmap：两类包都有条目，带版本号，占位符已替换
    const map = await readFile(join(dir, 'dist', 'importmap.js'), 'utf8');

    assert.match(map, /'pkg-a': '\/lib\/pkg-a\/index\.min\.js\?v=1\.0\.0-[0-9a-f]{8}',/);
    assert.match(map, /'pkg-b': '\/lib\/pkg-b\/index\.min\.js\?v=1\.0\.0-[0-9a-f]{8}',/);
    assert.equal(map.includes('__NPM2ESM_IMPORT_MAP__'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run：skipPackages 不构建也不进 importmap', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'pkg-a', { 'index.js': 'export const a = 1;\n' }, { main: 'index.js' });
    await writeFakePackage(dir, 'pkg-b', { 'index.js': 'export const b = 1;\n' }, { main: 'index.js' });

    await writeWorkspace(dir, {
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
      config: { output: 'dist', lib: 'lib', skipPackages: ['pkg-a'] },
    });

    await run(dir, [], { strategies: STRATEGIES });

    assert.equal(existsSync(join(dir, 'dist', 'lib', 'pkg-a')), false);
    assert.ok(existsSync(join(dir, 'dist', 'lib', 'pkg-b', 'index.min.js')));

    const map = await readFile(join(dir, 'dist', 'importmap.js'), 'utf8');

    assert.equal(map.includes('pkg-a'), false);
    assert.match(map, /'pkg-b': '/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run：显式指定包时只重建该包，但 importmap 表保留其它依赖条目', async () => {
  const dir = await createTempDir();

  try {
    await writeFakePackage(dir, 'pkg-a', { 'index.js': 'export const a = 1;\n' }, { main: 'index.js' });
    await writeFakePackage(dir, 'pkg-b', { 'index.js': 'export const b = 1;\n' }, { main: 'index.js' });

    await writeWorkspace(dir, {
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^1.0.0' },
      config: { output: 'dist', lib: 'lib' },
    });

    await run(dir, ['pkg-b'], { strategies: STRATEGIES });

    // 只构建了 pkg-b
    assert.ok(existsSync(join(dir, 'dist', 'lib', 'pkg-b', 'index.min.js')));
    assert.equal(existsSync(join(dir, 'dist', 'lib', 'pkg-a')), false);

    // 表里仍是全部依赖：pkg-a 未构建但条目保留（plan 通道语义）
    const map = await readFile(join(dir, 'dist', 'importmap.js'), 'utf8');

    assert.match(map, /'pkg-a': '/);
    assert.match(map, /'pkg-b': '/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run：--clear 安全阀——lib 等于 workspace 时拒绝清空', async () => {
  const dir = await createTempDir();

  try {
    await writeWorkspace(dir, {
      dependencies: {},
      config: { output: '.', lib: '.' },
    });

    await assert.rejects(
      () => run(dir, [], { clearOutput: true, strategies: STRATEGIES }),
      /拒绝清空 workspace 自身或其祖先目录/,
    );

    // 安全阀先于删除执行：工作区完好
    assert.ok(existsSync(join(dir, 'package.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run：构建失败的包置 exitCode=1 且不进 importmap', async () => {
  const dir = await createTempDir();
  const prevExitCode = process.exitCode;

  process.exitCode = 0;

  try {
    await writeFakePackage(dir, 'bad-pkg', {});
    await writeFakePackage(dir, 'ok-pkg', { 'index.js': 'export const a = 1;\n' }, { main: 'index.js' });

    await writeWorkspace(dir, {
      dependencies: { 'bad-pkg': '^1.0.0', 'ok-pkg': '^1.0.0' },
      config: {
        output: 'dist',
        lib: 'lib',
        packages: { 'bad-pkg': [{ from: 'src/missing.js', to: 'index.min.js' }] },
      },
    });

    await run(dir, [], { strategies: STRATEGIES });

    assert.equal(process.exitCode, 1);

    // 失败包无产物（构建前的空包目录会残留）、无条目；成功包不受影响
    assert.equal(existsSync(join(dir, 'dist', 'lib', 'bad-pkg', 'index.min.js')), false);

    const map = await readFile(join(dir, 'dist', 'importmap.js'), 'utf8');

    assert.equal(map.includes('bad-pkg'), false);
    assert.match(map, /'ok-pkg': '/);
  } finally {
    process.exitCode = prevExitCode;
    await rm(dir, { recursive: true, force: true });
  }
});
