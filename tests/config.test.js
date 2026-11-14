import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

import { resolveContainedDir, resolveSkipPackages, resolveUrlBase } from '../build.js';

const CONFIG_PATH = '/tmp/npm2esm.config.js';

test('urlBase 默认值为 /lib/', () => {
  assert.equal(resolveUrlBase(undefined, CONFIG_PATH), '/lib/');
});

test('urlBase 必须是 / 或 ./ 开头结尾且不含 ..', () => {
  assert.equal(resolveUrlBase('/_site/lib/', CONFIG_PATH), '/_site/lib/');
  assert.equal(resolveUrlBase('./_site/lib/', CONFIG_PATH), './_site/lib/');
  assert.throws(() => resolveUrlBase('lib', CONFIG_PATH), /urlBase 必须以 \/ 或 \.\//);
  assert.throws(() => resolveUrlBase('/lib', CONFIG_PATH), /urlBase 必须以 \/ 或 \.\//);
  assert.throws(() => resolveUrlBase('./lib', CONFIG_PATH), /urlBase 必须以 \/ 或 \.\//);
  assert.throws(() => resolveUrlBase('/a/../lib/', CONFIG_PATH), /urlBase 必须以 \/ 或 \.\//);
  assert.throws(() => resolveUrlBase('./../lib/', CONFIG_PATH), /urlBase 必须以 \/ 或 \.\//);
});

test('skipPackages 默认空集合，仅接受字符串数组', () => {
  assert.equal(resolveSkipPackages(undefined, CONFIG_PATH).size, 0);
  assert.deepEqual([...resolveSkipPackages(['a', 'b'], CONFIG_PATH)], ['a', 'b']);
  assert.throws(() => resolveSkipPackages('a', CONFIG_PATH), /skipPackages 必须是字符串数组/);
  assert.throws(() => resolveSkipPackages(['a', 1], CONFIG_PATH), /skipPackages 必须是字符串数组/);
});

test('包名不能跳出目标目录', () => {
  const base = resolve('/tmp/npm2esm-base');

  assert.match(resolveContainedDir(base, 'lodash'), /lodash$/);
  assert.match(resolveContainedDir(base, '@scope/pkg'), /@scope[\\/]pkg$/);
  assert.throws(() => resolveContainedDir(base, '..'), /非法的包名/);
  assert.throws(() => resolveContainedDir(base, '../evil'), /非法的包名/);
  assert.throws(() => resolveContainedDir(base, ''), /非法的包名/);
  assert.throws(() => resolveContainedDir(base, resolve('/tmp/evil')), /非法的包名/);
});
