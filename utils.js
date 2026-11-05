import { isAbsolute, relative } from 'node:path';

/**
 * @fileoverview
 * 跨层共享的无状态纯函数库，用于构建流程中的路径和配置处理。
 *
 * 这些函数适用于流程层 (build.js)、策略层 (strategies/*)
 * 与任务层 (tasks/*)。
 */

function normalizeTask(task) {
  return typeof task === 'string' ? { from: task } : task;
}

export function getPackageTasks(packageConfig) {
  if (Array.isArray(packageConfig)) {
    return packageConfig.map(normalizeTask);
  }

  if (typeof packageConfig === 'string') {
    return [{ from: packageConfig }];
  }

  if (packageConfig && typeof packageConfig === 'object') {
    return [normalizeTask(packageConfig)];
  }

  return [];
}

export function hasPackageConfig(packageConfig) {
  return getPackageTasks(packageConfig).length > 0;
}

export function isStrictSubdirectory(parent, child) {
  const rel = relative(parent, child);

  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isWithinDirectory(parent, child) {
  const rel = relative(parent, child);

  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
