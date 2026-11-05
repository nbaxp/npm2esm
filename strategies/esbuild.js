import { relative, resolve } from 'node:path';

import { buildFailureError, runEsbuildTask } from '../tasks/esbuild.js';
import { buildCssSubpaths } from './css.js';

async function buildRootPackage(context) {
  const { packageName, rootDir, srcDirAbs, outputPackageDir } = context;

  const jsOutput = resolve(outputPackageDir, 'index.min.js');

  console.log(`\n🔹 构建 ${packageName} (自动)`);

  console.log(`   js min:      ${relative(rootDir, jsOutput)}`);

  try {
    const { entryPoint } = await runEsbuildTask({
      rootDir,
      srcDirAbs,
      entryPoints: [packageName],
      outfile: jsOutput,
      options: {
        format: 'esm',
        minify: true,
        mainFields: ['browser', 'module', 'main'],
        conditions: ['browser', 'import', 'module', 'default'],
      },
    });

    if (entryPoint) {
      console.log(`   entry:       ${entryPoint}`);
    }

    console.log(`✅ ${packageName} 构建完成`);

    return {
      success: true,
      kind: 'root',
      specifier: packageName,
      importMap: [
        {
          key: packageName,
          value: `${context.urlBase}${packageName}/index.min.js`,
          dev: false,
        },
      ],
    };
  } catch (error) {
    const failure = buildFailureError(packageName, error);

    console.warn(`\n⚠️  跳过 ${packageName}\n   原因：${failure.message}`);

    return {
      success: false,
      kind: 'root',
      specifier: packageName,
      error: failure,
    };
  }
}

export default {
  name: 'esbuild',

  match() {
    // 默认 fallback。
    return true;
  },

  // 只算 importmap 条目，不产出任何文件（供全量注入复用）
  plan(context) {
    return [
      {
        key: context.packageName,
        value: `${context.urlBase}${context.packageName}/index.min.js`,
        dev: false,
      },
    ];
  },

  async build(context) {
    const results = [];

    // 根包失败也继续尝试 CSS subpath。
    results.push(await buildRootPackage(context));

    results.push(...(await buildCssSubpaths(context)));

    return {
      // 只有根包失败才算自动包失败。
      // CSS subpath 失败只记录。
      success: results[0].success,
      results,
      importMap: results[0].importMap,
    };
  },
};
