import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { copyPackageFile } from '../tasks/copy.js';
import { minifyPackageFile } from '../tasks/esbuild.js';
import { buildCssSubpaths } from './css.js';

// dist/<base>.esm-browser(.prod).js 候选，match 与 build 共用
function findBrowserEsmFiles(context) {
  const distDir = resolve(context.packageDir, 'dist');
  const base = basename(context.packageName);

  const normal = resolve(distDir, `${base}.esm-browser.js`);
  const prod = resolve(distDir, `${base}.esm-browser.prod.js`);

  return {
    normal: existsSync(normal) ? normal : null,
    prod: existsSync(prod) ? prod : null,
  };
}

export default {
  name: 'browser-esm',

  match(context) {
    const { normal, prod } = findBrowserEsmFiles(context);

    return normal !== null || prod !== null;
  },

  // 只算 importmap 条目，不产出任何文件（供全量注入复用）
  plan(context) {
    const files = findBrowserEsmFiles(context);

    if (!files.normal && !files.prod) return [];

    return [
      {
        key: context.packageName,
        value: `${context.urlBase}${context.packageName}/index.min.js`,
        dev: false,
      },
      {
        key: context.packageName,
        value: `${context.urlBase}${context.packageName}/index.js`,
        dev: true,
      },
    ];
  },

  async build(context) {
    const files = findBrowserEsmFiles(context);

    if (!files.normal && !files.prod) {
      throw new Error(`未找到 browser ESM 文件：${context.packageName}`);
    }

    const results = [];

    const indexJs = resolve(context.outputPackageDir, 'index.js');

    const indexMinJs = resolve(context.outputPackageDir, 'index.min.js');

    if (files.normal && files.prod) {
      await copyPackageFile(files.normal, indexJs);
      await copyPackageFile(files.prod, indexMinJs);
    } else if (files.normal) {
      await copyPackageFile(files.normal, indexJs);
      await minifyPackageFile(files.normal, indexMinJs);
    } else {
      await copyPackageFile(files.prod, indexJs);
      await copyPackageFile(files.prod, indexMinJs);
    }

    results.push({
      success: true,
      kind: 'root',
      output: indexJs,
      minifiedOutput: indexMinJs,
    });

    results.push(...(await buildCssSubpaths(context)));

    return {
      success: results[0].success,
      results,
      importMap: [
        {
          key: context.packageName,
          value: `${context.urlBase}${context.packageName}/index.min.js`,
          dev: false,
        },
        {
          key: context.packageName,
          value: `${context.urlBase}${context.packageName}/index.js`,
          dev: true,
        },
      ],
    };
  },
};
