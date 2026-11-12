import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { runCopyTask } from '../tasks/copy.js';
import { runEsbuildTask } from '../tasks/esbuild.js';
import { getPackageTasks, hasPackageConfig, isStrictSubdirectory } from '../utils.js';

// ---------------------------------------------------------------------------
// import map 推断
// ---------------------------------------------------------------------------

// 从配置任务列表推断 import map 条目。
// 规则：
//   1. 显式声明 importmap: true 的任务直接用
//   2. 否则找唯一 .min.js 输出（排除 copy: true 且 to 非 .js 的）
//   3. 多个 .min.js 且无 importmap: true，取第一个
//
// 另外：只要该包有产物落在子目录（如 addons/、fonts/、es/locale/），就额外产出一条前缀映射
// `pkg/` → `<urlBase>pkg/`，包内子路径（如 cherry-markdown/addons/xxx.esm.js）也能走 importmap。
// 前缀与包入口相互独立：没有 .min.js 入口的包（如 cherry-markdown 只做原样 copy）也能只拿前缀。
function hasSubdirectoryOutput(tasks) {
  return tasks.some((task) => {
    // 省略 to 时按 copy/glob 规则落到 from 所在目录，因此用 to ?? from 判断真实落点
    const output = typeof task.to === 'string' ? task.to : task.from;

    if (typeof output !== 'string') return false;

    // 含 '/' 说明落在子目录；没有扩展名说明 to 本身就是目录（如 fonts、i18n）
    return output.includes('/') || !/\.[^/]+$/.test(output);
  });
}

function resolvePackageEntry(packageName, tasks, urlBase) {
  // 过滤出 JS 输出任务（有 to 且以 .js 结尾，或 to 为空默认 index.min.js）。
  // copy 任务没写 to 时只是原样拷目录，不会产出 index.min.js（如 mathjax），不能算入口。
  const jsTasks = tasks.filter((t) => {
    if (t.copy === true && t.to == null) return false;

    const to = t.to ?? 'index.min.js';
    return to.endsWith('.js');
  });

  if (jsTasks.length === 0) return null;

  // 优先取显式声明 importmap: true 的
  const explicit = jsTasks.find((t) => t.importmap === true);
  if (explicit) {
    return {
      key: packageName,
      value: `${urlBase}${packageName}/${explicit.to ?? 'index.min.js'}`,
      dev: false,
    };
  }

  // 单 .min.js 直接用；多个取第一个
  const minJsTasks = jsTasks.filter((t) => (t.to ?? 'index.min.js').endsWith('.min.js'));
  if (minJsTasks.length === 0) return null;

  return {
    key: packageName,
    value: `${urlBase}${packageName}/${minJsTasks[0].to ?? 'index.min.js'}`,
    dev: false,
  };
}

function resolveImportMapEntry(packageName, tasks, urlBase) {
  const entries = [];

  const entry = resolvePackageEntry(packageName, tasks, urlBase);
  if (entry) entries.push(entry);

  if (hasSubdirectoryOutput(tasks)) {
    entries.push({ key: `${packageName}/`, value: `${urlBase}${packageName}/`, dev: false });
  }

  return entries.length > 0 ? entries : null;
}

// ---------------------------------------------------------------------------
// 任务执行
// ---------------------------------------------------------------------------

async function runCopy(context, task, index) {
  const taskName = `${context.packageName} 任务${index + 1} (copy)`;

  console.log(`\n🔧 ${taskName}`);

  await runCopyTask(context, task);

  console.log(`✅ ${taskName} 完成`);
}

async function runBundle(context, task, index) {
  const { packageName, rootDir, srcDirAbs, packageDir, outputPackageDir } = context;

  // importmap 是条目推断的保留键，不得透传给 esbuild（Invalid option）
  const { from, to: toRel, importmap: _importmap, ...rest } = task;

  if (typeof from !== 'string' || from === '') {
    throw new Error(`${packageName} 的 from 必须是非空字符串`);
  }

  if (toRel !== undefined && typeof toRel !== 'string') {
    throw new Error(`${packageName} 的 to 必须是字符串`);
  }

  // from 相对包目录解析，可用 ../ 跳出（如 entries/shiki）
  const resolvedEntry = resolve(packageDir, from);

  const outfile = resolve(outputPackageDir, toRel ?? 'index.min.js');

  // to 语义为"相对包输出目录的文件"，不得用 ../ 跳出
  if (!isStrictSubdirectory(outputPackageDir, outfile)) {
    throw new Error(`非法的 to（跳出包输出目录）：${toRel}`);
  }

  const taskName = `${packageName} 任务${index + 1} (esbuild)`;

  console.log(`\n🔧 ${taskName}`);
  console.log(`   from: ${relative(rootDir, resolvedEntry)}`);
  console.log(`   to:   ${relative(rootDir, outfile)}`);

  await runEsbuildTask({
    rootDir,
    srcDirAbs,
    entryPoints: [resolvedEntry],
    outfile,
    options: {
      format: 'esm',
      minify: true,
      ...rest,
    },
  });

  console.log(`✅ ${taskName} 完成`);
}

export default {
  name: 'configured',

  match(context) {
    return hasPackageConfig(context.packageConfig);
  },

  // 只算 importmap 条目，不产出任何文件（供全量注入复用）
  plan(context) {
    if (!hasPackageConfig(context.packageConfig)) return [];

    const entry = resolveImportMapEntry(
      context.packageName,
      getPackageTasks(context.packageConfig),
      context.urlBase,
    );

    return entry ?? [];
  },

  async build(context) {
    // 包输出目录统一由策略创建，copy 任务无需再建目录
    await mkdir(context.outputPackageDir, { recursive: true });

    const tasks = getPackageTasks(context.packageConfig);

    // 任务按序执行：任一任务失败即抛出，后续任务不再执行，整包判失败
    for (const [index, task] of tasks.entries()) {
      if (task?.copy === true) {
        await runCopy(context, task, index);
      } else if (task && typeof task.from === 'string' && task.from !== '') {
        await runBundle(context, task, index);
      } else {
        throw new Error(`无法识别的任务：${JSON.stringify(task)}`);
      }
    }

    const importMapEntry = resolveImportMapEntry(context.packageName, tasks, context.urlBase);

    return {
      success: true,
      importMap: importMapEntry ?? undefined,
    };
  },
};
