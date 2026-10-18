# dsh-pick

**帮你在 DSH 生态里选对插件。**

说需求 → 找候选 → 多维比较 → 出结论。下载量只是证据，判断才算数。

> 定位对比：`dsh-find-plugin` 负责「**找到**」（搜 GitHub 仓库，按 star 排）；
> `dsh-pick` 负责「**挑对**」（算去噪指标，给首选 / 备选 / 不推荐）。
> 一个 `find_dsh_plugin`，一个 `pick_plugin`。

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

首次使用要先生成目录（在 dsh-pick 的安装目录下，或任意目录）：

```sh
npx dsh-pick build --deep 332
```

不跑也行——面板会提示「目录未生成」，排行榜和搜索会空着，但界面照常打开。

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
│   ├── classify.js     13 类 + 其他，关键词加权分类
│   ├── metrics.js      去噪指标：基线 / 增速 / 节奏 / 新鲜度 / 健康度
│   ├── words.js        需求 → 搜索词（同义词 + 中文二元切分），CLI 与面板共用
│   └── normalize.js    （在 engine.js 内）排名与链接字段
├── data/catalog.json   目录产物
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

- **来源**：`registry.npmjs.org`（元数据、版本发布历史）+ `api.npmjs.org/downloads`（下载量）
- **滞后**：npm 统计约滞后 5 天，页面显示的「数据截止」是最后一个已汇总的完整日
- **覆盖**：npm 上带 `dsh-plugin` 关键字的 2,250 个包（search 接口深分页上限约 2,250）
- **去噪范围**：只有周下载 Top 332 会抓 30 天日序列和发布历史，其余只有周/月下载量
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

**待做**
- 更多 AI 工具：`pick_trend`（走势）/ `pick_export`（导出结论）
- skill `plugin-analyst`（意图路由 + 更完整的口径说明）
- AI 语义分类，把「其他」从 29% 压到 10% 以内
- 周报（可指定方向）
- PDF 导出（DSH Desktop 可用 Electron `printToPDF`）

---

## 发布流程（每次发版照这个走，一步都别省）

```sh
cd /Users/wf/dsh/dsh-pick

# 1. 改 package.json 里的 version（npm 不许覆盖已发布版本）
# 2. 提交并推 GitHub —— 代码是真源，必须早于 npm
git add -A && git commit -m "vX.Y.Z：改了什么"
git push origin main

# 3. 打 tag 并推送（必须，用来对应 npm 版本）
git tag -a vX.Y.Z -m "dsh-pick vX.Y.Z：改了什么"
git push origin vX.Y.Z

# 4. 发布 npm（会问 OTP）
npm publish

# 5. 验证
npm view dsh-pick version                                    # 应等于 X.Y.Z
```

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

MIT
