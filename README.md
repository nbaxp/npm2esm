# npm2esm

把 npm 依赖预构建成浏览器可直接 `import` 的 ESM 产物，运行时不参与打包。

产物是静态文件 + 一份 `importmap`：浏览器按 import map 解析裸包名，不需要运行时打包器。

## 环境要求

- Node.js >= 20（见 `package.json` 的 `engines`）。
- 依赖 `esbuild`，随本包安装。

## 安装

```sh
npm i npm2esm
```

也可以直接用 npx：

```sh
npx npm2esm .
```

## 快速使用

在目标工作区目录执行：

```sh
npm2esm .
npm2esm . --clear
npm2esm . vue lodash
npm2esm . --config ./npm2esm/config.js
```

参数：

1. `workspace`：工作区目录，相对当前目录，默认当前目录。
2. `package...`：只构建指定包；不在 `dependencies` 中也会构建。
3. `--clear`：先清空整个 `lib` 再构建。
4. `--config <path>`：指定 config 文件路径，相对当前目录；优先于 `NPM2ESM_CONFIG`。
5. `--help` / `-h`：显示帮助。

环境变量：

1. `NPM2ESM_CONFIG`：自定义 config 路径，相对当前目录；默认依次查找 `<workspace>/npm2esm.config.js`、`<workspace>/npm2esm/config.js`。
2. `NPM2ESM_CONCURRENCY`：并发数，默认 4；非法值回退 4。

## 工作区契约

工作区必须提供 `package.json`，其 `dependencies` 是默认的构建名单（`skipPackages` 可排除其中部分包）。

config 文件位于根目录 `npm2esm.config.js`，或集中在 `npm2esm/config.js`；`--config` / `NPM2ESM_CONFIG` 可指定其他路径（`.json` 按 JSON 解析，其余按 ESM 导入 `default`）。

```js
export default {
  output: '.', // 产物根目录，相对工作区
  lib: 'lib', // 库目录，相对 output；每个包输出到 <output>/<lib>/<package>/
  urlBase: '/lib/', // importmap 中的库 URL 前缀
  skipPackages: ['typescript'], // 不参与构建的依赖
  packages: {
    dayjs: 'esm/index.js', // 按包名的构建任务
  },
};
```

配置项：

- `output`（必填）：产物根目录，相对工作区；缺失直接报错。
- `lib`（必填）：库目录，相对 `output`；缺失直接报错。
- `urlBase`（可选，默认 `/lib/`）：浏览器侧库 URL 前缀，必须是字符串、以 `/` 开头且以 `/` 结尾、不含 `..`，否则报错。importmap 条目值直接由它拼接生成；它只影响 URL 字符串，不改变磁盘上的 `<output>/<lib>/` 布局，部署时需让该前缀指向该目录。
- `skipPackages`（可选，默认空）：字符串数组，从 `dependencies` 派生的默认名单中排除这些包，也不为其生成 importmap 条目；CLI 位置参数显式指定的包仍强制构建。
- `packages`：按包名声明构建任务（见「配置 DSL」）；未声明的包走自动策略。

config 不存在时按无配置继续，但会因缺少 `output` / `lib` 报错。

## 输出与 importmap

1. 包产物写入 `<output>/<lib>/<package>/`；importmap 位于 `<output>/importmap.js`。
2. 每次构建都重建 importmap：读取 config 同目录的 `importmap.template.js`，替换模板里的显式占位符；模板里硬编码的条目保留，同键不重复插入（硬编码条目必须已使用配置的 `urlBase` 前缀）。模板与既有 importmap 都不存在时，使用内置默认模板生成 importmap 文件并打印提示。
3. 条目来源是 `dependencies`（排除 `skipPackages`）加上本轮显式指定的包，均用策略的 `plan` 计算，构建失败的包不进表。条目按键名排序，非合法 JS 标识符的键加引号。
4. config 包的产物落在子目录时，额外产出 `包名/` → `<urlBase>包名/` 前缀映射；`browser-esm` 策略同时产出 `index.min.js`（prod）与 `index.js`（dev）两条。
5. 所有指向产物的 URL 追加 `?v=<version>-<内容哈希>`：版本取包清单的 `version`（读不到为 `0.0.0`），哈希取产物内容的 sha256 前 8 位，产物不变则哈希不变。目录前缀 URL（以 `/` 结尾）和已带 `v=` 的 URL 跳过；产物不存在时保留原 URL 并汇总警告。
6. URL 相对 `<output>/<lib>/` 定位真实产物，因此 `urlBase` 只决定对外路径，不参与磁盘解析。

### 模板占位符

模板里用独占一行的显式标记占位，整行（连同行首缩进）会被生成的条目替换：

```js
// __NPM2ESM_IMPORT_MAP__       → 替换为 prod 条目
// __NPM2ESM_DEV_IMPORT_MAP__   → 替换为 dev 条目
```

标记可写在任意注释里（如 `// __NPM2ESM_IMPORT_MAP__（自动生成）`），无需逐字一致。

模板结构约定（内置解析依赖以下两处声明）：

```js
const devImportMap = isDev ? { ... } : {};
const importMap = { imports: { ...devImportMap } };
```

也就是说，dev 区块必须位于 `const devImportMap` 与 `const importMap` 之间，否则条目会被当作 prod。

## 配置 DSL

```js
export default {
  output: '.',
  lib: 'lib',
  packages: {
    dayjs: 'esm/index.js',
    'element-plus': [
      { copy: true, from: 'dist/index.full.min.mjs', to: 'index.min.js' },
      { copy: true, from: 'dist/index.css', to: 'index.min.css' },
    ],
  },
};
```

- `output`、`lib`、`urlBase`、`skipPackages` 是保留键，不会被当作包名；按包名的任务统一放在 `packages` 下。
- `packages` 下按包名声明构建任务；包不在 `packages` 中时走自动策略。
- 字符串：等价于省略 `to` 的单个 esbuild 任务。
- 对象：单个任务；`copy: true` 表示复制，否则走 esbuild。
- 数组：按顺序执行多个任务，任一失败则整包失败。
- esbuild 任务的 `to` 相对包输出目录，不允许 `../` 跳出；省略时默认 `index.min.js`。显式声明 `external` 时完全以声明为准（不自动排除入口包的 `peerDependencies`，适合把 peer 栈整体内联的聚合打包）；未声明时入口包的 `peerDependencies` 自动排除。
- copy 任务的 `from` 相对包目录，省略 `to` 时按源相对路径复制（glob 则落入源所在目录）；`from` 支持单层 `*` 和 `{a,b}` glob，零匹配会报错。
- `from` 可包含 `../`，用于引用工作区里的自定义 entry（例如 `../../entries/shiki/index.js`）。
- `importmap: true` 可显式指定该任务作为包的 importmap 入口；未指定时取第一个 `.min.js` 输出。

## 策略

按顺序匹配，命中即停止：

1. `configured`：config 中有该包配置，按任务顺序执行。
2. `browser-esm`：存在 `dist/<pkg>.esm-browser.js` 或 `.prod.js`，生成 `index.js` / `index.min.js`，并处理 CSS subpaths。
3. `esbuild`：默认 fallback，以包名为入口 bundle 到 `index.min.js`，并处理 CSS subpaths。

自动策略会从 `style`、`exports` 和常见文件名推断 CSS subpath；CSS 失败只记录，不影响包整体成败。

## 程序化 API

```js
import { run } from 'npm2esm';
import { STRATEGIES } from 'npm2esm/strategies';

await run('path/to/workspace', [], {
  clearOutput: false,
  strategies: STRATEGIES,
});
```

`run(target, targetPackages, options)` 在包级构建失败时设置 `process.exitCode = 1`；workspace、config 或路径错误会直接抛出。`options` 还支持 `configPath`（等价 `--config`）。

## 安全与限制

1. 包名会校验，不能通过 `../` 跳出 `node_modules` 或输出目录。
2. `to` 不能跳出包输出目录。
3. `--clear` 会清空整个 `lib`；即使同时指定包名，也会先清空，再只重建指定包，其它包不会自动恢复。
4. Windows 上输出目录被占用时，删除会重试 3 次。
5. 内置 `node:test` 测试，覆盖 CLI 参数、config 校验、importmap 生成、三个构建策略、CSS subpath 收集、主流程端到端（含清理安全阀与失败汇总）与路径穿越防护：

```sh
npm test
```

## 排错

1. `工作区 ... 不存在或缺少 package.json`：`workspace` 参数指错了。
2. `缺少 output` / `缺少 lib` / `urlBase ...` / `skipPackages ...`：config 字段缺失或不合法（报错信息会带上实际使用的 config 路径）。
3. `npm 包不存在`：目标工作区没有安装对应依赖，先在应用目录 `npm install`。
4. `Cannot find package 'esbuild'`：本包依赖未安装完整，重新执行 `npm i npm2esm`。
5. config 文件存在但报语法错误：本工具不会吞掉损坏的 config，修好或删除后重试。
6. `未找到 importmap.template.js 与 importmap.js，已按默认模板生成`：首次构建且没有模板，属正常提示；需要自定义结构时补 `importmap.template.js`。

## 发布说明

`package.json` 中的 `repository` / `homepage` / `bugs` 指向 `https://github.com/nbaxp/npm2esm`。

发布由 `.github/workflows/publish.yml` 承载：推送 `v*` Tag 时校验 Tag 与 `package.json` 版本一致、测试、`npm pack`、`npm publish <tgz>`（npm OIDC Trusted Publisher，需在 npm 侧配置 GitHub Actions 为 Trusted Publisher）并创建 GitHub Release；手动触发默认只做 `npm publish --dry-run`，正式手动发布需选择 `v*` Tag 并将 `dry_run` 设为 `false`。

发版步骤：

1. 确认 `npm test` 全过。
2. 更新 `package.json` 的 `version`（如 `npm version patch` / `minor` / `major`）。
3. 提交并打同名 Tag（`v0.1.2` 形式）推送，工作流自动完成发布与 Release。

## 目录结构

```text
npm2esm/
├── index.js          # CLI
├── build.js          # 构建主流程
├── importmap.js      # importmap 生成链（模板/条目合并/版本注入）
├── utils.js          # 纯函数
├── strategies/       # 策略
├── tasks/            # copy / esbuild 任务
├── tests/            # node:test 测试
├── .github/workflows/publish.yml
├── LICENSE
├── README.md
└── package.json
```
