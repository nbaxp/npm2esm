import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { extractLibEntries, formatImportMapEntries, injectImportMap } from '../importmap.js';
import browserEsmStrategy from '../strategies/browser-esm.js';
import configuredStrategy from '../strategies/configured.js';
import esbuildStrategy from '../strategies/esbuild.js';

// 临时目录统一 .temp_ 前缀，测试结束即删除
async function createTempDir() {
  return mkdtemp(join(tmpdir(), '.temp_npm2esm-'));
}

const TEMPLATE = `const isDev = new URLSearchParams(location.search).get('env') === 'dev';
const devImportMap = isDev
  ? {
      // __NPM2ESM_DEV_IMPORT_MAP__
    }
  : {};
const importMap = {
  imports: {
    'vue': '/_site/lib/vue/index.min.js',
    // __NPM2ESM_IMPORT_MAP__
    ...devImportMap,
  },
};
`;

test('extractLibEntries 按 prod/dev 区块拆分并去掉版本号', () => {
  const content = `const devImportMap = isDev
  ? {
      vue: '/lib/vue/index.js?v=3.5.44-abc12345',
    }
  : {};
const importMap = { imports: {
  'lodash-es': '/lib/lodash-es/index.min.js?v=4.0.0-def67890',
  ...devImportMap,
} };`;

  const { prod, dev } = extractLibEntries(content);

  assert.equal(dev.get('vue'), '/lib/vue/index.js');
  assert.equal(prod.get('lodash-es'), '/lib/lodash-es/index.min.js');
  assert.equal(prod.has('vue'), false);
});

test('extractLibEntries 按传入的 urlBase 匹配', () => {
  const content = `const devImportMap = {};\nconst importMap = { imports: {\n  katex: '/_site/lib/katex/index.min.js',\n} };`;

  assert.equal(extractLibEntries(content, '/_site/lib/').prod.get('katex'), '/_site/lib/katex/index.min.js');
  assert.equal(extractLibEntries(content, '/lib/').prod.size, 0);
});

test('formatImportMapEntries 排序并按标识符合法性加引号', () => {
  const text = formatImportMapEntries(
    new Map([
      ['vue', '/lib/vue/index.min.js'],
      ['@vue/devtools-api', '/lib/@vue/devtools-api/index.min.js'],
      ['lodash-es', '/lib/lodash-es/index.min.js'],
    ]),
  );

  const lines = text.split('\n');

  assert.deepEqual(lines, [
    "'@vue/devtools-api': '/lib/@vue/devtools-api/index.min.js',",
    "'lodash-es': '/lib/lodash-es/index.min.js',",
    "vue: '/lib/vue/index.min.js',",
  ]);
});

test('无模板时生成默认模板并写入条目与版本号', async () => {
  const dir = await createTempDir();

  try {
    const configDir = join(dir, 'config');
    const outputDir = join(dir, 'site');
    const libDir = join(outputDir, 'lib');
    const srcDirAbs = join(dir, 'node_modules');

    await mkdir(join(libDir, 'vue'), { recursive: true });
    await mkdir(join(srcDirAbs, 'vue'), { recursive: true });

    const bundle = 'console.log("vue bundle");';

    await writeFile(join(libDir, 'vue', 'index.min.js'), bundle);
    await writeFile(join(srcDirAbs, 'vue', 'package.json'), JSON.stringify({ version: '3.5.44' }));

    await injectImportMap({
      configDir,
      outputDir,
      libDir,
      srcDirAbs,
      importMap: [{ key: 'vue', value: '/lib/vue/index.min.js' }],
      urlBase: '/lib/',
    });

    const content = await readFile(join(outputDir, 'importmap.js'), 'utf8');
    const digest = createHash('sha256').update(bundle).digest('hex').slice(0, 8);

    assert.match(content, /const devImportMap/);
    assert.match(content, /const importMap = {/);
    assert.ok(content.includes(`vue: '/lib/vue/index.min.js?v=3.5.44-${digest}',`));
    assert.equal(content.includes('__NPM2ESM_IMPORT_MAP__'), false);
    assert.equal(content.includes('__NPM2ESM_DEV_IMPORT_MAP__'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('自定义 urlBase 时模板硬编码键不重复插入，产物 URL 注入版本号', async () => {
  const dir = await createTempDir();

  try {
    const configDir = join(dir, 'config');
    const outputDir = join(dir, 'site');
    const libDir = join(outputDir, 'lib');
    const srcDirAbs = join(dir, 'node_modules');

    await mkdir(configDir, { recursive: true });
    await mkdir(join(libDir, 'vue'), { recursive: true });
    await mkdir(join(libDir, 'lodash-es'), { recursive: true });
    await mkdir(join(srcDirAbs, 'vue'), { recursive: true });
    await mkdir(join(srcDirAbs, 'lodash-es'), { recursive: true });

    await writeFile(join(configDir, 'importmap.template.js'), TEMPLATE);
    await writeFile(join(libDir, 'vue', 'index.min.js'), 'vue');
    await writeFile(join(libDir, 'lodash-es', 'index.min.js'), 'lodash');
    await writeFile(join(srcDirAbs, 'vue', 'package.json'), JSON.stringify({ version: '3.5.44' }));
    await writeFile(join(srcDirAbs, 'lodash-es', 'package.json'), JSON.stringify({ version: '4.0.0' }));

    await injectImportMap({
      configDir,
      outputDir,
      libDir,
      srcDirAbs,
      importMap: [
        { key: 'vue', value: '/_site/lib/vue/index.min.js' },
        { key: 'lodash-es', value: '/_site/lib/lodash-es/index.min.js' },
      ],
      urlBase: '/_site/lib/',
    });

    const content = await readFile(join(outputDir, 'importmap.js'), 'utf8');

    assert.equal(content.includes("'/lib/"), false);
    assert.ok(content.includes("'vue': '/_site/lib/vue/index.min.js?v=3.5.44-"));
    assert.ok(content.includes("'lodash-es': '/_site/lib/lodash-es/index.min.js?v=4.0.0-"));
    // 模板已硬编码 vue，不应出现第二条
    assert.equal(content.match(/'vue':/g).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('策略条目值直接由 urlBase 生成', async () => {
  const dir = await createTempDir();

  try {
    const packageDir = join(dir, 'vue');

    await mkdir(join(packageDir, 'dist'), { recursive: true });
    await writeFile(join(packageDir, 'dist', 'vue.esm-browser.js'), 'vue');

    const context = {
      packageName: 'vue',
      packageConfig: { from: 'index.js', to: 'index.min.js' },
      packageDir,
      urlBase: '/_site/lib/',
    };

    assert.deepEqual(esbuildStrategy.plan(context), [
      { key: 'vue', value: '/_site/lib/vue/index.min.js', dev: false },
    ]);

    assert.deepEqual(configuredStrategy.plan(context), [
      { key: 'vue', value: '/_site/lib/vue/index.min.js', dev: false },
    ]);

    assert.deepEqual(browserEsmStrategy.plan(context), [
      { key: 'vue', value: '/_site/lib/vue/index.min.js', dev: false },
      { key: 'vue', value: '/_site/lib/vue/index.js', dev: true },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
