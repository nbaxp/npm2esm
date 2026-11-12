// importmap 生成链：模板恢复、条目合并、版本注入。
// 从 build.js 独立出来，职责只此一件；构建主流程见 build.js。
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_URL_BASE = '/lib/';

const IMPORT_MAP_FILENAME = 'importmap.js';
const IMPORT_MAP_TEMPLATE_FILENAME = 'importmap.template.js';

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
// 条目值统一剥掉版本号（?v=），版本号由 addVersionToLibUrls 统一重算。
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
// 条目值已由策略按 urlBase 直接生成，最后统一按 urlBase 给产物 URL 加版本号。
// 模板与既有产物都不存在时按默认模板生成，不再静默跳过。
// 模板中硬编码的条目必须已使用配置的 urlBase 前缀（dev 条目同理），否则
// 解析不到会重复插入、旧前缀值会成为死映射——工具不做前缀归一。
export async function injectImportMap({ configDir, outputDir, libDir, srcDirAbs, importMap, urlBase = DEFAULT_URL_BASE }) {
  const importMapPath = resolve(outputDir, IMPORT_MAP_FILENAME);

  // 模板与 config 同目录（config 在根目录时与旧行为一致）；这里先恢复带占位符的模板，
  // 否则已注入过的 importmap.js 没有占位符，版本号永远不会更新。
  const templatePath = resolve(configDir, IMPORT_MAP_TEMPLATE_FILENAME);

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

    console.warn(`⚠️  未找到 ${IMPORT_MAP_TEMPLATE_FILENAME} 与 ${IMPORT_MAP_FILENAME}，已按默认模板生成`);
  }

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
