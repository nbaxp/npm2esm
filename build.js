import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hasPackageConfig, isStrictSubdirectory, isWithinDirectory } from './utils.js';

const NODE_MODULES = 'node_modules';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_IMPORT_MAP_FILENAME = 'importmap.js';
const DEFAULT_IMPORT_MAP_TEMPLATE = 'importmap.template.js';
const DEFAULT_URL_BASE = '/lib/';

// importmap 占位符：显式标记，模板里写在哪一行都可以，整行会被条目替换
const IMPORT_MAP_MARKER = '__NPM2ESM_IMPORT_MAP__';
const DEV_IMPORT_MAP_MARKER = '__NPM2ESM_DEV_IMPORT_MAP__';

// 模板与既有产物都不存在时生成的默认模板，
// 结构约定：dev 条目进 devImportMap，prod 条目进 importMap.imports
const DEFAULT_IMPORT_MAP_TEMPLATE_CONTENT = `const isDev = new URLSearchParams(location.search).get('env') === 'dev';
const devImportMap = isDev
  ? {
      // ${DEV_IMPORT_MAP_MARKER}
    }
  : {};
const importMap = {
  imports: {
    // ${IMPORT_MAP_MARKER}
    ...devImportMap,
  },
};
const script = document.createElement('script');
script.type = 'importmap';
script.textContent = JSON.stringify(importMap, null, 2);
document.currentScript.after(script);
`;

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

// 浏览器侧库目录前缀：默认 /lib/；必须 / 开头结尾，禁止 .. 穿越
export function resolveUrlBase(value, configPath) {
  if (value === undefined) return DEFAULT_URL_BASE;

  if (typeof value !== 'string' || !value.startsWith('/') || !value.endsWith('/') || value.split('/').includes('..')) {
    throw new Error(`npm2esm 配置的 urlBase 必须以 / 开头、以 / 结尾且不含 ..（${configPath}）`);
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

// importmap 产物文件名与模板文件名可配置；默认 importmap.js / importmap.template.js
export function resolveImportMapOptions(config, configPath) {
  const importMapFile = config.importMapFile ?? DEFAULT_IMPORT_MAP_FILENAME;
  const importMapTemplate = config.importMapTemplate ?? DEFAULT_IMPORT_MAP_TEMPLATE;

  for (const [key, value] of [
    ['importMapFile', importMapFile],
    ['importMapTemplate', importMapTemplate],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`npm2esm 配置的 ${key} 必须是非空字符串（${configPath}）`);
    }
  }

  return {
    importMapFile,
    importMapTemplate,
  };
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
// import map 生成
// ---------------------------------------------------------------------------

// 读取包版本号，带缓存
async function readPackageVersion(srcDirAbs, packageName, cache) {
  if (cache.has(packageName)) return cache.get(packageName);

  let version = '0.0.0';

  try {
    const manifest = JSON.parse(await readFile(resolve(srcDirAbs, packageName, 'package.json'), 'utf8'));

    version = manifest.version ?? '0.0.0';
  } catch {
    // 读不到就退回 0.0.0，不影响构建
  }

  cache.set(packageName, version);

  return version;
}

// 从 urlBase 开头的 URL 中解析包名（支持 @scope/name）
function getPackageNameFromLibUrl(url, urlBase) {
  const rest = url.slice(urlBase.length);
  const parts = rest.split('/');

  if (parts[0].startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  return parts[0] || null;
}

// 将 prod/dev 条目格式化为模板可用的行（单引号风格，与模板一致）
// 合法 JS 标识符不加引号，其余（含 / @ - 等）加引号
export function formatImportMapEntries(entries) {
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `'${key}'`;

      return `${safeKey}: '${value}',`;
    })
    .join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 给内容中所有 urlBase 开头的 URL 追加 ?v=<version>-<产物内容 sha256 前 8 位>。
// 版本号取包清单里的 version（便于人读），hash 取真实产物内容（内容变才变）。
// URL 相对 libDir 定位真实产物，与部署前缀 urlBase 解耦。
// 产物不存在时不写版本号，末尾汇总提示，避免死映射悄悄躺着。
async function addVersionToLibUrls(content, { srcDirAbs, libDir, urlBase }) {
  const versionCache = new Map(); // packageName -> version
  const tagCache = new Map(); // url -> "v=x.y.z-abcdef12" | null
  const missing = new Set(); // 没有产物的 URL

  async function getVersionTag(url) {
    if (tagCache.has(url)) return tagCache.get(url);

    const filePath = resolve(libDir, url.slice(urlBase.length));

    let tag = null;

    try {
      const digest = createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex')
        .slice(0, 8);

      const packageName = getPackageNameFromLibUrl(url, urlBase);
      const version = packageName ? await readPackageVersion(srcDirAbs, packageName, versionCache) : '0.0.0';

      tag = `v=${version}-${digest}`;
    } catch {
      missing.add(url);
    }

    tagCache.set(url, tag);

    return tag;
  }

  // 匹配 '...' 或 "..." 形式的 urlBase URL，含可选 ?query
  const urlRegex = new RegExp(`(['"])(${escapeRegExp(urlBase)}[^'"?]+)(\\?[^'"]*)?(['"])`, 'g');

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = urlRegex.exec(content)) !== null) {
    const [full, quote1, urlBase, existingQuery, quote2] = match;

    // 前缀映射（如 '/lib/cherry-markdown/'）指向目录，没有产物文件可算 hash，跳过
    if (urlBase.endsWith('/')) {
      continue;
    }

    // 已有 v= 参数的不重复追加
    if (existingQuery && /[?&]v=/.test(existingQuery)) {
      continue;
    }

    const tag = await getVersionTag(urlBase);

    // 产物不存在：保留原始 URL（不带版本号），已在 missing 里记录
    if (!tag) {
      continue;
    }

    const sep = existingQuery ? '&' : '?';

    result += content.slice(lastIndex, match.index);
    result += `${quote1}${urlBase}${existingQuery ?? ''}${sep}${tag}${quote2}`;
    lastIndex = match.index + full.length;
  }

  result += content.slice(lastIndex);

  if (missing.size > 0) {
    console.warn(`⚠️  import map 有 ${missing.size} 条指向不存在的产物：`);

    for (const url of [...missing].sort()) {
      console.warn(`     ${url}`);
    }
  }

  return result;
}

// 从 importmap 文本里解析已有的库条目，按所在区块分成 prod/dev。
// 单包构建只产出本轮条目，必须与既有映射合并，否则会把其它包全部丢掉。
// 解析发生在版本注入之前，故按配置的 urlBase 匹配（模板里的旧 /lib/ 会先被归一）。
export function extractLibEntries(content, urlBase = DEFAULT_URL_BASE) {
  const prod = new Map();
  const dev = new Map();

  const devStart = content.indexOf('const devImportMap');

  // dev 区块以 `: {};`（三元 else）结尾；模板把它写在下一行，不能用 "} : {};" 匹配
  const devEndFromElse = devStart >= 0 ? content.indexOf(': {};', devStart) : -1;
  const devEnd = devEndFromElse >= 0 ? devEndFromElse : content.indexOf('const importMap');

  const escaped = urlBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const entryRegex = new RegExp(
    `^[ \\t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))[ \\t]*:[ \\t]*['"](${escaped}[^'"]+)['"]`,
    'gm',
  );

  let match;

  while ((match = entryRegex.exec(content)) !== null) {
    const key = match[1] ?? match[2] ?? match[3];
    const value = match[4].replace(/\?[^'"]*$/, '');
    const inDevBlock = devStart >= 0 && devEnd > devStart && match.index > devStart && match.index < devEnd;

    (inDevBlock ? dev : prod).set(key, value);
  }

  return { prod, dev };
}

// 兼容旧模板：把引号内以 /lib/ 开头的值归一到配置的 urlBase。
// 只用于读取模板/既有产物时归一，条目本身由策略按 urlBase 直接生成。
function rewriteLibPrefix(content, urlBase) {
  if (urlBase === DEFAULT_URL_BASE) return content;

  return content.replace(/(['"])\/lib\//g, (_, quote) => `${quote}${urlBase}`);
}

// 占位符替换：整行（含 marker）换成条目，保留行首缩进；无条目时删掉该行
function replaceMarker(content, marker, block) {
  const pattern = new RegExp(`^[ \\t]*[^\\n]*${escapeRegExp(marker)}[^\\n]*$`, 'gm');

  return content.replace(pattern, (line) => {
    if (!block) return '';

    const indent = line.match(/^[ \t]*/)[0];

    return block
      .split('\n')
      .map((item) => `${indent}${item}`)
      .join('\n');
  });
}

// 用模板重建 importmap：写入完整条目表（模板硬编码的键不重复插入），
// 条目值已由策略按 urlBase 生成，最后统一按 urlBase 给产物 URL 加版本号。
// 模板与既有产物都不存在时按默认模板生成，不再静默跳过。
export async function injectImportMap({
  configDir,
  outputDir,
  libDir,
  srcDirAbs,
  importMap,
  urlBase = DEFAULT_URL_BASE,
  importMapFile = DEFAULT_IMPORT_MAP_FILENAME,
  importMapTemplate = DEFAULT_IMPORT_MAP_TEMPLATE,
}) {
  const importMapPath = resolve(outputDir, importMapFile);

  // 模板与 config 同目录（config 在根目录时与旧行为一致）；这里先恢复带占位符的模板，
  // 否则已注入过的 importmap.js 没有占位符，版本号永远不会更新。
  const templatePath = resolve(configDir, importMapTemplate);

  let templateContent = '';

  try {
    templateContent = await readFile(templatePath, 'utf8');
  } catch {
    // 模板不存在时沿用现有文件（兼容旧结构）
  }

  let existingContent = '';

  try {
    existingContent = await readFile(importMapPath, 'utf8');
  } catch {
    // 首次构建，没有既有产物
  }

  let content = templateContent || existingContent;

  if (!content) {
    content = DEFAULT_IMPORT_MAP_TEMPLATE_CONTENT;

    console.warn(`⚠️  未找到 ${importMapTemplate} 与 ${importMapFile}，已按默认模板生成`);
  }

  // 旧模板里的 /lib/ 值先归一到 urlBase，后续解析、注入、版本号都只认 urlBase
  content = rewriteLibPrefix(content, urlBase);

  const hardcoded = extractLibEntries(templateContent ? content : '', urlBase);

  const prodEntries = new Map();
  const devEntries = new Map();

  for (const item of importMap) {
    const bucket = item.dev ? devEntries : prodEntries;
    const skip = item.dev ? hardcoded.dev : hardcoded.prod;

    // 模板里已硬编码的键不再重复插入
    if (skip.has(item.key)) continue;

    bucket.set(item.key, item.value.replace(/\?[^'"]*$/, ''));
  }

  let newContent = replaceMarker(content, DEV_IMPORT_MAP_MARKER, formatImportMapEntries(devEntries));

  newContent = replaceMarker(newContent, IMPORT_MAP_MARKER, formatImportMapEntries(prodEntries));

  // 统一给所有 urlBase 开头的产物 URL 追加版本号（含模板中已有的硬编码 URL）
  newContent = await addVersionToLibUrls(newContent, { srcDirAbs, libDir, urlBase });

  if (newContent !== existingContent) {
    await writeFile(importMapPath, newContent, 'utf8');

    console.log(`📝 import map 已写入：${prodEntries.size} prod + ${devEntries.size} dev`);
  }
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
  const { importMapFile, importMapTemplate } = resolveImportMapOptions(packageConfigs, configPath);

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
    importMapFile,
    importMapTemplate,
  });

  // 自动构建根入口失败、config 包任务失败才视为包失败。
  // CSS subpath 失败只记录，不让其他包中断。

  const failed = results.filter((result) => result.success === false);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
