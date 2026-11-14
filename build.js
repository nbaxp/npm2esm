import { existsSync } from 'node:fs';
import { access, mkdir, readdir, rm, stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_URL_BASE, injectImportMap } from './importmap.js';
import { hasPackageConfig, isStrictSubdirectory, isWithinDirectory } from './utils.js';

const NODE_MODULES = 'node_modules';
const DEFAULT_CONCURRENCY = 4;


// Windows 上输出目录常被 dev server / 编辑器 / 杀软占用，rm 会抛 EBUSY、EPERM；
// 而 maxRetries 默认是 0（不重试），表现为"目录只被删了一半"。统一开启重试。
const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
};

async function removeDirectory(dir) {
  await rm(dir, RM_OPTIONS);
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// 只有"配置文件不存在"才按无配置继续；文件存在但损坏（语法错误、内部依赖缺失等）直接抛出
async function loadConfig(configPath) {
  try {
    await access(configPath);
  } catch (error) {
    // 仅文件不存在按无配置继续；无权限等其他 IO 错误不掩盖
    if (error.code === 'ENOENT') return {};

    throw error;
  }

  if (configPath.endsWith('.json')) {
    return JSON.parse(await readFile(configPath, 'utf8'));
  }

  const mod = await import(pathToFileURL(configPath).href);

  return mod.default ?? mod;
}

function resolveConfigPath(targetDir, explicitPath) {
  // CLI --config 优先于环境变量，均相对当前工作目录
  if (explicitPath) {
    return resolve(explicitPath);
  }

  const configured = process.env.NPM2ESM_CONFIG;

  if (configured) {
    return resolve(configured);
  }

  // 约定查找：根目录 npm2esm.config.js 优先，其次 npm2esm/ 子目录的 config.js（build 输入集中放置）
  const candidates = [resolve(targetDir, 'npm2esm.config.js'), resolve(targetDir, 'npm2esm/config.js')];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

// 浏览器侧库目录前缀：默认 /lib/；必须 / 或 ./ 开头、/ 结尾，禁止 .. 穿越
// ./ 开头表示相对文档 base URL 解析，配合 HTML <base> 可适配根目录/子目录部署
export function resolveUrlBase(value, configPath) {
  if (value === undefined) return DEFAULT_URL_BASE;

  if (
    typeof value !== 'string' ||
    !value.endsWith('/') ||
    !(value.startsWith('/') || value.startsWith('./')) ||
    value.split('/').includes('..')
  ) {
    throw new Error(`npm2esm 配置的 urlBase 必须以 / 或 ./ 开头、以 / 结尾且不含 ..（${configPath}）`);
  }

  return value;
}

// 不参与浏览器映射与构建的包（Node-only、会被内联进自定义入口的依赖等）
export function resolveSkipPackages(value, configPath) {
  if (value === undefined) return new Set();

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`npm2esm 配置的 skipPackages 必须是字符串数组（${configPath}）`);
  }

  return new Set(value);
}


// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

async function resolvePaths(target, config, configPath) {
  // 工具独立于工作区：target 相对当前工作目录解析，默认由 CLI 传进程 cwd
  const targetDir = resolve(target);

  let manifest;

  const manifestPath = resolve(targetDir, 'package.json');

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`工作区 "${target}" 不存在或缺少 package.json：${targetDir}`, {
        cause: error,
      });
    }

    throw new Error(`读取工作区 "${target}" 的 package.json 失败：${manifestPath}`, {
      cause: error,
    });
  }

  const output = config.output;

  if (!output) {
    throw new Error(`npm2esm 配置缺少 output（${configPath}）`);
  }

  const lib = config.lib;

  if (!lib) {
    throw new Error(`npm2esm 配置缺少 lib（${configPath}）`);
  }

  const outputDir = resolve(targetDir, output);
  const libDir = resolve(outputDir, lib);

  return {
    targetDir,
    rootDir: targetDir,
    outputDir,
    libDir,
    // 依赖统一装在目标工作区的 node_modules（与 lint/check 共用一套）
    srcDirAbs: resolve(targetDir, NODE_MODULES),
    dependencies: Object.keys(manifest.dependencies ?? {}),
    urlBase: resolveUrlBase(config.urlBase, configPath),
  };
}

// ---------------------------------------------------------------------------
// 构建 Context（策略层只依赖 context）
// ---------------------------------------------------------------------------

// 包名来自 CLI，拒绝空路径、../ 穿越与跨盘符绝对路径（@scope/name 合法）
export function resolveContainedDir(baseDir, packageName) {
  const dir = resolve(baseDir, packageName);

  if (!isStrictSubdirectory(baseDir, dir)) {
    throw new Error(`非法的包名：${packageName}`);
  }

  return dir;
}

function createBuildContext(packageName, packageConfig, paths) {
  return {
    packageName,
    packageConfig,

    rootDir: paths.rootDir,
    srcDirAbs: paths.srcDirAbs,

    // 条目值直接由 urlBase 生成，策略层不再硬编码 /lib/
    urlBase: paths.urlBase,

    // node_modules/<package>，包名不得跳出 node_modules
    packageDir: resolveContainedDir(paths.srcDirAbs, packageName),

    // 工作区输出目录下的包目录，包名不得跳出 outputDir
    outputPackageDir: resolveContainedDir(paths.outputDir, packageName),
  };
}

// ---------------------------------------------------------------------------
// 策略解析与包分发
//
// 策略由组合根注入，lib 只依赖策略协议 { name, match, build }，
// 不 import 任何具体策略。
// ---------------------------------------------------------------------------

function resolveStrategy(strategies, context) {
  const strategy = strategies.find((item) => item.match(context));

  if (!strategy) {
    throw new Error(`没有可用的构建策略：${context.packageName}`);
  }

  return strategy;
}

async function buildPackage(context, strategy) {
  console.log(`   strategy:   ${strategy.name}`);

  const result = await strategy.build(context);

  return {
    packageName: context.packageName,
    success: result.success !== false,
    results: result.results ?? [],
    importMap: result.importMap,
  };
}

// ---------------------------------------------------------------------------
// 并发
// ---------------------------------------------------------------------------

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);

  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          packageName: items[index],
          success: false,
          error,
        };
      }
    }
  }

  const workers = Array.from(
    {
      length: Math.min(concurrency, items.length),
    },
    () => runWorker(),
  );

  await Promise.all(workers);

  return results;
}

function resolveConcurrency() {
  const value = Number(process.env.NPM2ESM_CONCURRENCY);

  // 先 floor 再判 >= 1：0.5/0/负数/NaN 一律回退默认值，
  // 否则 0 个 worker 会"不构建但成功"
  const concurrency = Number.isFinite(value) ? Math.floor(value) : 0;

  return concurrency >= 1 ? concurrency : DEFAULT_CONCURRENCY;
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

async function cleanPackageOutput({ outputDir, packageName }) {
  const dir = resolveContainedDir(outputDir, packageName);

  await removeDirectory(dir);

  // @scope/name：叶子删掉后父级可能已空，一并回收，避免遗留空的 @scope 目录
  const parent = dirname(dir);

  if (parent === outputDir) return;

  let remaining;

  try {
    remaining = await readdir(parent);
  } catch {
    // 父目录不存在等，无需回收
    return;
  }

  if (remaining.length === 0) {
    await removeDirectory(parent);
  }
}

async function cleanOutput({ outputDir, packages }) {
  for (const packageName of packages) {
    console.log(`🧹 清空 ${packageName} 的输出`);

    await cleanPackageOutput({
      outputDir,
      packageName,
    });
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

function createCompletionMessage({ results, only }) {
  const packageSuccess = results.filter((result) => result.success !== false);

  const packageFailed = results.filter((result) => result.success === false);

  const entryFailures = results.flatMap((result) =>
    (result.results ?? [])
      .filter((item) => item.success === false)
      .map((item) => ({
        packageName: result.packageName,
        ...item,
      })),
  );

  const scope = only.length > 0 ? `${only.join(', ')} 包` : '所有依赖包';

  const lines = ['', `🎉 ${scope}处理完成！`, `   成功：${packageSuccess.length}`, `   失败：${packageFailed.length}`];

  if (entryFailures.length > 0) {
    lines.push(`   失败项：${entryFailures.length}`, '', '   失败详情：');

    for (const item of entryFailures) {
      lines.push(`     - ${item.packageName}: ${item.specifier}`);

      if (item.error?.message) {
        lines.push(`       ${item.error.message.split('\n')[0]}`);
      }
    }
  }

  if (packageFailed.length > 0) {
    lines.push('', '   失败包：');

    for (const item of packageFailed) {
      lines.push(`     - ${item.packageName}`);

      if (item.error?.message) {
        lines.push(`       ${item.error.message.split('\n')[0]}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 构建包
// ---------------------------------------------------------------------------

async function buildPackages(packages, packageConfigs, paths, strategies) {
  const concurrency = resolveConcurrency();

  console.log(`⚙️  并发数：${concurrency}`);

  return mapLimit(packages, concurrency, async (packageName) => {
    const context = createBuildContext(packageName, packageConfigs.packages?.[packageName], paths);

    // 路径安全只保证包名不越界，不保证包已安装；显式检查给出可定位的错误
    let installed;

    try {
      installed = (await stat(context.packageDir)).isDirectory();
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        installed = false;
      } else {
        throw error;
      }
    }

    if (!installed) {
      throw new Error(`npm 包不存在：${packageName}`);
    }

    const strategy = resolveStrategy(strategies, context);

    return buildPackage(context, strategy);
  });
}

// 只算 importmap 条目不构建：让策略自己报出「这个包会产出什么映射」。
// 未安装的包直接跳过，避免表里出现凭空条目。
async function planImportMap({ packageNames, packageConfigs, paths, strategies }) {
  const entries = [];

  for (const packageName of packageNames) {
    const context = createBuildContext(packageName, packageConfigs.packages?.[packageName], paths);

    let installed;

    try {
      installed = (await stat(context.packageDir)).isDirectory();
    } catch {
      installed = false;
    }

    if (!installed) continue;

    const strategy = resolveStrategy(strategies, context);

    entries.push(...(strategy.plan?.(context) ?? []));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function run(target, targetPackages = [], options = {}) {
  const { clearOutput = false, configPath: explicitConfigPath, strategies } = options;

  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new Error('run() 缺少 strategies 注入');
  }

  // ---------------------------------------------------------------
  // 运行时加载 config
  //
  // 不在 build.js 模块加载时执行。
  // 这样 build.js 可以被组合根安全 import。
  // ---------------------------------------------------------------

  const targetDir = resolve(target);
  const configPath = resolveConfigPath(targetDir, explicitConfigPath);
  const packageConfigs = await loadConfig(configPath);

  const { outputDir, libDir, srcDirAbs, dependencies, urlBase } = await resolvePaths(
    targetDir,
    packageConfigs,
    configPath,
  );

  const skipPackages = resolveSkipPackages(packageConfigs.skipPackages, configPath);

  const paths = {
    rootDir: targetDir,
    outputDir: libDir,
    srcDirAbs,
    urlBase,
  };

  // CLI 位置参数是强制构建目标：即使不在 dependencies 中也按包名构建（包名须通过路径安全校验）
  const only = new Set(targetPackages);

  // 黑名单只影响 dependencies 默认名单；CLI 显式指定的包仍然构建
  const dependencyTargets = dependencies.filter((packageName) => !skipPackages.has(packageName));

  const packages = only.size > 0 ? [...only] : dependencyTargets;

  // ---------------------------------------------------------------
  // 输出目录清理
  //
  // 先清理、后判断空名单：否则工作区没有 dependencies 时，
  // 清理会被"空名单早退"跳过，表现为 --clear 静默失效。
  // ---------------------------------------------------------------

  // --clear 优先于包名：存在即清空整个 lib；否则按 packages 名单逐个清理
  if (clearOutput) {
    // 安全阀放在日志之前：避免"打印了清空日志却抛错没清"的误导。
    // workspace 自身不得位于 lib 目录之内（含相等），否则会误删工作区
    if (isWithinDirectory(libDir, targetDir)) {
      throw new Error(`拒绝清空 workspace 自身或其祖先目录：${libDir}`);
    }

    console.log(`🧹 清空 lib：${libDir}`);

    await removeDirectory(libDir);
  } else {
    console.log(`🧹 按包清理 lib`);

    await cleanOutput({
      outputDir: libDir,
      packages,
    });
  }

  await mkdir(libDir, {
    recursive: true,
  });

  await mkdir(outputDir, {
    recursive: true,
  });

  if (packages.length === 0) {
    console.log(`⚠️  工作区 "${target}" 没有 dependencies。`);

    return;
  }

  const configured = packages.filter((packageName) => hasPackageConfig(packageConfigs.packages?.[packageName]));

  const automatic = packages.filter((packageName) => !hasPackageConfig(packageConfigs.packages?.[packageName]));

  console.log(`📦 待处理：${packages.length}`);

  if (configured.length > 0) {
    console.log(`   🔧 走 config：${configured.length}（${configured.join(', ')}）`);
  }

  if (automatic.length > 0) {
    console.log(`   🤖 自动构建：${automatic.length}`);
  }

  const results = await buildPackages(packages, packageConfigs, paths, strategies);

  console.log(
    createCompletionMessage({
      results,
      only: [...only],
    }),
  );

  // 表里永远放全部：先按依赖名单 + 本轮目标算出条目（不构建），再用本轮真实结果覆盖。
  // 构建失败的包不进表。
  const failedPackages = new Set(
    results.filter((result) => result.success === false).map((result) => result.packageName),
  );

  const plannedImportMap = await planImportMap({
    packageNames: [...new Set([...dependencyTargets, ...packages])],
    packageConfigs,
    paths,
    strategies,
  });

  const importMap = [
    ...plannedImportMap.filter((item) => !failedPackages.has(item.key)),
    ...results.flatMap((result) =>
      (result.importMap ?? []).map((item) => ({
        ...item,
        packageName: result.packageName,
      })),
    ),
  ].filter((item) => item?.key && item?.value);

  await injectImportMap({
    configDir: dirname(configPath),
    outputDir,
    libDir,
    srcDirAbs,
    importMap,
    urlBase,
  });

  // 自动构建根入口失败、config 包任务失败才视为包失败。
  // CSS subpath 失败只记录，不让其他包中断。

  const failed = results.filter((result) => result.success === false);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
