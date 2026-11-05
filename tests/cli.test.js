import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs } from '../index.js';

test('无参数：默认构建当前目录全部依赖', () => {
  assert.deepEqual(parseArgs([]), {
    clearOutput: false,
    configPath: undefined,
    help: false,
    positional: [],
  });
});

test('位置参数与 --clear 混排', () => {
  assert.deepEqual(parseArgs(['.', 'vue', 'lodash', '--clear']), {
    clearOutput: true,
    configPath: undefined,
    help: false,
    positional: ['.', 'vue', 'lodash'],
  });
});

test('--help 与 -h 等价', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('未知选项报错，不当作包名', () => {
  assert.throws(() => parseArgs(['--clea']), /未知参数：--clea/);
});

test('-- 之后一律按位置参数', () => {
  assert.deepEqual(parseArgs(['.', '--', '--clear']), {
    clearOutput: false,
    configPath: undefined,
    help: false,
    positional: ['.', '--clear'],
  });
});

test('--config 支持空格与等号两种写法', () => {
  assert.equal(parseArgs(['.', '--config', 'config.js']).configPath, 'config.js');
  assert.equal(parseArgs(['--config=config.js', '.']).configPath, 'config.js');
});

test('--config 缺值报错', () => {
  assert.throws(() => parseArgs(['--config']), /--config 需要一个文件路径/);
  assert.throws(() => parseArgs(['--config', '--clear']), /--config 需要一个文件路径/);
});
