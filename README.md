# dsh-pick

[![npm version](https://img.shields.io/npm/v/dsh-pick.svg?style=flat-square)](https://www.npmjs.com/package/dsh-pick)
[![npm downloads](https://img.shields.io/npm/dm/dsh-pick.svg?style=flat-square)](https://www.npmjs.com/package/dsh-pick)
[![license](https://img.shields.io/npm/l/dsh-pick.svg?style=flat-square)](LICENSE)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/aicivilization/dsh-pick)

**帮你在 DSH 生态里选对插件。**

说需求 → 找候选 → 多维比较 → 出结论。下载量只是证据，判断才算数。

> 定位对比：`dsh-find-plugin` 负责「**找到**」（搜 GitHub 仓库，按 star 排）；
> `dsh-pick` 负责「**挑对**」（算去噪指标，给首选 / 备选 / 不推荐）。
> 一个 `find_dsh_plugin`，一个 `pick_plugin`。

---

## 安装

```sh
dsh plugin --profile web add dsh-pick                        # DSH 插件（推荐）
npm i -g dsh-pick                                            # 命令行 / 独立网页
dsh plugin --profile web add github:AIcivilization/dsh-pick  # 源码安装
```

- **能力分类**：工具与能力（插件选购顾问）
- **运行要求**：Node.js ≥ 20；DSH web profile（右侧栏面板 + 设置页）
- **许可证**：[MIT](LICENSE)
- **数据边界**：只读公开的 npm API 和本仓库的每日目录，不外传任何数据

---

## 为什么需要它

npm 官网和各类 stat 站能看数字，但看数字回答不了「我该装哪个」。

更麻烦的是，**npm 下载量是噪声极大的指标**：版本一发布，CI、镜像、npm 客户端缓存刷新会把当天数字推高一个数量级。按原始下载量排出来的「第一」，很可能只是「发版本最勤的那个」。

所以 `dsh-pick` 的核心不是下载量，而是**去噪后的指标**：

| 指标 | 含义 |
|---|---|
| 日常基线 | 扣掉发布日与次日后的每日中位数，最接近真实使用量 |
| 近 7 日环比 | 在涨还是在凉 |
| 版本节奏 | 平均几天发一个版本，维护者的投入度 |
| 最近更新 | 是不是已经弃坑 |
| 健康度 | 以上四项加权，基线 40% + 增速 25% + 新鲜度 20% + 节奏 15% |

效果示例：`dshmarket` 周下载 160,042，日常基线只有 19,721 —— 相差 8 倍。

---

## 用法

### 作为 DSH 插件（推荐）

```sh
dsh plugin --profile web add dsh-pick
```

装完重启 `dsh web`，在**右侧栏**的引导页点「选插件」，就是完整的选插件面板。
**设置 → dsh-pick** 是精简页：版本 / 更新 / 卸载、怎么打开面板、数据口径。
面板顶部一行：插件名、当前版本号、更新按钮，最右侧是卸载按钮——更新和卸载都交给 DSH 自己的插件管理器，完成后重启 DSH 生效。

**和对话联动**（这是插件版比独立网页好用的地方）：

- **+AI**：候选卡片、「候选」「结论」「我的监控」的标题上都有。点一下，把这块的需求和关键数字整理成一段话发到当前对话，AI 在对话里结合你的场景分析。只发结论和数字，不发原始数据；输入框里有你没发出的文字时不会覆盖。
- **在对话里直接问**：插件给 AI 注册了 4 个工具，不开面板也行，直接问「我想装个数据库插件，哪个靠谱？」，AI 会自己查目录、比较。

  | 工具 | 作用 |
  |---|---|
  | `pick_search` | 按需求找候选 |
  | `pick_stats` | 查几个插件的详细数据（目录里没有去噪指标的实时查 npm） |
  | `pick_compare` | 2~6 个插件逐项对比，标出每项最好的 |
  | `pick_rank` | 全部或某一类的排行 |

  每个工具的结果都带口径说明，并要求 AI 只引用工具给的数字，不自己推算。
- **安装**：候选卡片上点「安装 → 确认安装」，交给 DSH 的插件管理器装；已装的显示「✓ 已安装」。只能装目录里有的插件（带 `dsh-plugin` 关键字的 npm 包）。
- **装之前先看能不能装**：卡片上会提醒——
  - ✓ 兼容你的 DSH / ⚠ 和你的 DSH 不兼容（需要 …）：问的是插件市场（dshmarket）的兼容性接口，规则和它安装前的检查一致；没装插件市场就不显示这一项
  - ⚠ 没声明 dsh.bundle：DSH 一定拒绝安装
  - ⚠ tui 客户端插件：装进桌面版 / 网页版可能让 DSH 起不来
  - ⚠ 你已装同类：功能可能重叠

  装不了的不给「安装」按钮，AI 工具的结果里也带着同样的提醒。

**一键加入监控**：搜索结果和各个榜单里，GitHub、npm 图标前面都有彩色的 **+**，点一下加入「我的监控」，变成 ✓；再点移出。只在 GitHub、没发到 npm 的插件也能加。

**5 个榜单**（排行榜顶部切换）：

| 榜单 | 数据来源 | 排序 |
|---|---|---|
| npm 榜 | npm 下载统计，去噪后 | 日常基线 / 周下载 / 增速 / 健康度 |
| GitHub 榜 | 插件仓库，一个仓库一行 | 星标 / 最近提交 / Fork / 讨论 |
| 官方榜 | DeepSeek 官方包 `@deepseek-ai/dsh-official-bundles` | 周下载 |
| 社区榜 | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（非官方，dshmarket 也用它） | 星标 / 30 天下载 / 新上架 |
| 商店榜 | [dsh-plugin-shop](https://github.com/LivXue/dsh-plugin-shop)（第三方，非官方，没有下载量） | 星标 / 新上架 |

社区榜、商店榜每个指标只保留前 100 名。AI 工具 `pick_rank` 加 `board` 参数也能查这三个榜。

**DSH「插件 → 发现」的插件索引源**：dsh-pick 每天生成一份 DSH 官方格式（format 1）的插件索引：

```
https://cdn.jsdelivr.net/gh/AIcivilization/dsh-pick@catalog/index.json
```

- 在 DSH「插件」页打开实验功能「自定义插件索引」后，dsh-pick 启动时会自动把它加进「发现」的索引源，只加一次；你在「发现」里删掉后，不会再自动加回来。设置页有「添加到『发现』」按钮。
- 按官方规定，只收声明了 `dsh.bundle` 和顶层 `engines.dsh` 的插件（目前约 280 个，长尾插件大多没写 `engines.dsh`）。每条都先过官方校验器 `@deepseek-ai/dsh-plugin-market-index`，不合格的剔除，整份再校验一次。
- 带分类，以及「周下载 / 日常基线 / GitHub 星标 / 健康度」四个排序项。
- 插件作者想被收录：在 `package.json` 里写上 `"engines": { "dsh": "..." }`。

**数据每天自动更新**：GitHub Actions 每天重建一次目录，推到本仓库的 `catalog` 分支。插件启动时、之后每 6 小时检查一次，有新的就下载到 `~/.dsh/dsh-pick/`（先走 jsDelivr，再走 raw.githubusercontent.com）。取不到就用包里自带的那份，不影响使用；设置页会写明当前用的是哪份。

### 作为命令行 / 独立网页

```sh
npm i -g dsh-pick      # 或 npx dsh-pick

dsh-pick build --deep 332          # 抓目录 + 算去噪指标
dsh-pick serve --port 8891         # 起本地服务，打开面板
```

装好后浏览器开 `http://127.0.0.1:8891/`。

### 命令

| 命令 | 作用 |
|---|---|
| `build [--deep N] [--pages N]` | 抓目录并算去噪指标 |
| `build --deep-only` | 只补算缺失的去噪指标（不用重抓目录，省 5 分钟） |
| `search "<需求>"` | 按需求描述找候选 |
| `rank [--metric ...] [--cat ...]` | 排行榜，指标支持 `weekly` / `baseline` / `growth` / `score` |
| `stats <pkg> [pkg...]` | 精确数据，目录没有就实时查 npm |
| `serve [--port N]` | 本地预览面板 |

示例：

```sh
dsh-pick search "我想装个数据库"
dsh-pick search "任务完成时给我发微信通知"
dsh-pick rank --metric baseline --cat 记忆与上下文 --limit 20
```

---

## 结构

```
dsh-pick/
├── package.json
├── bin/dsh-pick.js     CLI 入口
├── lib/
│   ├── engine.js       数据引擎：抓目录、算指标、查询（一个引擎，多个入口）
│   ├── remote.js       每日更新的目录：检查、下载、校验、换上
│   ├── github.js       插件仓库的 GitHub 数据（构建时批量查、刷新时实时查）
│   ├── boards.js       官方榜、社区榜、商店榜的数据（构建时抓，只解析不执行）
│   ├── market-index.js 生成 DSH「发现」页用的插件索引（index.json）
│   ├── market-source.js 把插件索引加进 DSH「发现」的索引源
│   ├── classify.js     13 类 + 其他，关键词加权分类
│   ├── metrics.js      去噪指标：基线 / 增速 / 节奏 / 新鲜度 / 健康度
│   ├── words.js        需求 → 搜索词（同义词 + 中文二元切分），CLI 与面板共用
│   └── normalize.js    （在 engine.js 内）排名与链接字段
├── data/catalog.json   随包自带的目录（兜底；每日更新的那份在 ~/.dsh/dsh-pick/）
├── scripts/
│   ├── release.mjs     发版脚本（npm run release）
│   └── catalog-meta.mjs 每日目录发布前的校验
├── test/               npm test（Node 自带的 node:test，不装任何依赖）
├── .github/workflows/catalog.yml  每天重建目录、推到 catalog 分支
├── plugin/
│   ├── index.js        DSH 宿主端：挂 /api-dsh-pick/* 路由（面板、更新、卸载、安装）
│   ├── tools.js        给对话里的 AI 用的 4 个工具（pick_search / stats / compare / rank）
│   ├── client.js       右侧栏页签（iframe 复用 web/panel.html，转发「+AI」到对话）+ 设置页精简版
│   └── cordis.patch.yml 插进 DSH
└── web/
    ├── panel.html      选插件面板（独立调试用，也是插件内嵌的同一份）
    └── panel.js        面板逻辑
```

面板只有一份代码，两种宿主都认：独立 `dsh-pick serve` 走根路径，插件内嵌走 `/api-dsh-pick` 前缀（`panel.html` 顶部的小加载器自动判断）。

---

## 数据口径

- **来源**：`registry.npmjs.org`（元数据、版本发布历史）+ `api.npmjs.org/downloads`（下载量）+ GitHub（星标、Fork、未关闭 issue / PR、最近提交、是否归档）
- **滞后**：npm 的每日下载只在一天结束后汇总，最近常晚好几天；页面上的「数据截止」是 npm 真实有数据的最后一天。任何工具都拿不到当天的下载量
- **npm 缺数据的日子**：npm 偶尔整天没出统计（全 npm 都是 0，比如 2026-10-13～15）。这些天记为缺失，不参与日常基线和环比的计算，页面底部会列出来
- **「我的监控」刷新**：版本号、发版时间、GitHub 数据是即时的；周下载取 npm 搜索接口（大约一天更新一次，和目录同一口径）
- **覆盖**：约 5,300 个包。npm 上带 `dsh-plugin` 关键字的前 2,250 个（search 接口深分页上限约 2,250），加上 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 社区目录里列出、搜索接口翻不到的 npm 包（逐个核对过 npm 上确实有这个包）。社区目录补进来的包，带 scope 的周下载每 3 天刷新一次（npm 不支持批量查带 scope 的包，逐个查会被限流），其余每天刷新
- **去噪范围**：只有周下载 Top 332 会抓 30 天日序列和发布历史，其余只有周/月下载量
- **安装信息**：全部包都会读 npm 上最新版本的 manifest，记下有没有 `dsh.bundle`、客户端平台、声明的 DSH 版本要求
- **更新频率**：每天一次（GitHub Actions，北京时间 10:30 左右）
- **GitHub 数据**：每日构建时用 GraphQL 批量查（Actions 自带的令牌）；几个插件共用一个仓库时数据相同。排行榜里分「npm 榜」和「GitHub 榜」
- **下载量口径**：含 CI、镜像源、爬虫、缓存回源等非人类流量，**不等于用户数**

---

## 已实现 / 待做

**已实现**
- 目录构建（`build` / `build --deep-only`，带 3 轮补抓对付限流）
- 13 类自动分类
- 去噪指标 + 健康度
- 需求搜索（同义词 + 中文二元切分）
- 排行榜（4 种指标 × 分类筛选）
- 选插件四步流程 + 规则版结论
- 结论导出为独立网页
- 我的监控（localStorage）
- DSH 插件形态：右侧栏完整面板 + 设置页精简版，跟随 DSH 明暗主题；面板内更新 / 卸载本插件
- 「+AI」把面板内容发到对话；面板内一键安装插件
- 4 个 AI 工具：`pick_search` / `pick_stats` / `pick_compare` / `pick_rank`（口径随结果附上，禁止 AI 自己推算数字）
- 目录每天自动更新（GitHub Actions → catalog 分支 → 插件定时取）
- 装之前的检查：兼容性（借插件市场）、dsh.bundle、客户端平台、已装同类
- 自动化测试（`npm test`）与发版脚本（`npm run release`）

**待做**
- 更多 AI 工具：`pick_trend`（走势）/ `pick_export`（导出结论）
- skill `plugin-analyst`（意图路由 + 更完整的口径说明）
- AI 语义分类，把「其他」从 29% 压到 10% 以内
- 周报（可指定方向）
- PDF 导出（DSH Desktop 可用 Electron `printToPDF`）

---

## 发布流程

```sh
npm run release -- patch -m "改了什么"              # 0.3.1 → 0.3.2；也可以写 minor / major / 具体版本号
npm run release -- patch -m "改了什么" --dry-run    # 演练：只检查、只跑测试，什么都不改
```

在哪个目录运行都行。脚本按顺序做：

1. 检查：在 main 上、没有未提交的改动、没落后于 GitHub、标签和 npm 版本都还没用过
2. 跑测试（`npm test`），不过就停
3. 改版本号并提交 → 推 GitHub → 打标签并推送
4. `npm publish`（可能要在浏览器里确认）
5. 等到 npm 上真的能查到新版本才算完（npm 收下后要处理一两分钟）

**顺序不能反**：先 GitHub 再 npm，这样 npm 上每个版本都能在 git 里找到对应提交。

`package.json` 里的 `dsh.bundle` 声明**不能删**，否则 `dsh plugin add` 会直接拒绝安装：

```json
"dsh": {
  "bundle": { "patch": "./plugin/cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

---

## 许可

[MIT](LICENSE) · Copyright © 2026 AIcivilization

---

## 收录渠道

- [DSH Plugin Hub（dsh-plugin.org 社区插件市场）](https://dsh-plugin.org/plugins/aicivilization/dsh-pick)
- [awesome-dsh-plugin 精选列表](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- dsh-plugin-shop 插件商店（每日自动收录）
- 52DSH / tuofangzhe 插件目录（证据分级收录）
