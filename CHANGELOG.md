# 更新日志 / Changelog

本文件记录本仓库面向公众的版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

这是一个 **DeepSeek Harness（DSH）适配器**仓库，不是 magic-context 本体：它把
[magic-context](https://github.com/cortexkit/magic-context)（MIT，Copyright (c) 2025 Ufuk Altinok）
的上下文管理与记忆能力移植到 DSH 的插件 / surface 体系上。代码出处、被 vendored 的第三方文件与
钉住的上游 revision 见 [NOTICE](NOTICE)；上游自身的变更历史请见上游仓库。

## [Unreleased]

**缓存前缀不再被一次空转的 execute 重写；historian 信封解析补齐上游语义。** 两件都不是新特性，
是把上游写进文件头和 golden 里的既有约定补回来。

### Fixed

- **baseline 用冻结时钟渲染**：`refreshBaseline` 的 SOFT 路径取 `previous.frozenAt`，只有 HARD 才推进它。
  此前 `renderBaseline({ now: Date.now() })` 让 `compartmentHeader` 的 `§Cn§ [… 12m ago]` 每分钟变一次、
  `selectTier` 还会按墙钟换档，于是 `baselineBlockOf(target.text) === block` 这个「字节相同就不动」的保护
  永远不成立——**每一次 execute pass 都重写挂在第一个 user 节点上的 baseline**，后面整段 prompt 全按未命中重算。
  上游口径见 `crates/mc-module/src/m0_compose.rs:1-9`：「same inputs → same bytes … the expiry cutoff is
  frozen at the HARD by the caller, never read here from a live clock」。回归用例
  `tests/baseline-clock-freeze.spec.ts`（删掉那一行即两条全红）。
- **实测代价**（2026-11-09 11:57 → 11-10 17:03，1726 步）：43 条 baseline 记录里 35 条是软刷新，而同一会话
  只发布了 10 个 compartment；`published=[] 且 tokensDelta=0` 的 8 连发 execute 各烧掉 27–30 万 token；
  一次空转 pass 之后的下一步 `cacheRead=32,768`、prompt=303k（只有系统提示存活）。
- **historian 信封解析对齐上游 8 例 golden（7 例逐字一致，1 例仅空白）**：切信封当晚有 4 个用例读错 ——
  XML 实体不解码（`&lt;` 原样入库）、`<p1>` 正文里被引用的 `</p1>` 截断段落、正文里被引用的
  `</compartment>` 砍断整块（顺带把 1 条事实虚增成 15 条）、乱序 compartment 取错锚点。四种都是静默错误：
  不抛异常，只把摘要写坏。修法照上游语义 —— 实体只解一次、正文里的 close 只在最外层算、事件只认
  `<events>` 的顶层子元素、多个 compartment 取 `start` 最小者；legacy 裸 `<NAMING>` 块也认。
  `tests/historian-envelope.spec.ts` 新增 5 条用例钉住，删掉任一规则即红。

## [0.11.1] - 2026-11-07

**设置卡片目录自检。** 修复卡片把有效路由钉误标为 `(not in catalog)`：移除或改名 provider
后打开设置卡片，不会再拿过期目录比对配置值。

### Fixed

- 设置卡片不再把有效路由钉误标为 `(not in catalog)`：卡片挂载时若模型目录缓存已超过 60 秒
  就先重读一次宿主目录（`ensureFresh`）。此前目录只在 `llm/models-updated` /
  `connection/reset` 事件到达时刷新，卡片若错过事件（例如在移除/改名 provider 之后才打开），
  就会拿旧目录比对配置值，把实际存在的 `zth-anthropic/deepseek-flash` 标成不在目录中。
  事件驱动的即时刷新语义不变，只是补上了「打开时自检」这一层。自检阈值提为命名常量
  `MODEL_CATALOG_MAX_AGE_MS`（60 秒），便于按部署节奏调整。

## [0.11.0] - 2026-11-06

**设置卡片路由钉与门面重排。** 两类后台生成路由（维护 verify 与生成 historian）可以在设置
卡片里从宿主模型目录直接钉住或清空；画像评审的「无事可做」跳过改为每天一条 journal 心跳；
README 双语门面按「30 秒可装 → 5 分钟可感」重排并配实拍截图。

### Changed

- README 门面吸引力重排（双语同步）：npm registry 一行安装前置（源码构建降为开发子节）、
  新增「快速上手」（含 `ctx_reduce` → `[dropped §N§]` → `ctx_expand` 真实参数示例）、英文版
  补痛点引子与状态行、移除首段指向 DSH 的失效链接记号（DSH 无公开仓库页）、新增 npm version
  badge、能力表机制列短语化（镜像链/水位/内部日期细节下沉）、修正「`memory: {}` 才启用记忆
  车道」的过时说法（0.9.0 起默认开启，退路为 `memory.enabled: false`）、去除硬编码版本号与
  用例数；「界面与遥测」一节插入设置卡片与遥测胶囊面板实拍截图（`docs/img/`，README 用
  raw.githubusercontent 绝对 URL 引用，npm 页面可渲染且不增包体积）。
- 画像评审 pass 的「无事可做」跳过不再静默：`no-candidates` / `too-few` / `too-few-sessions`
  现在各打一条 info journal 心跳行，并同时写 24h 节流戳（`profile_last_review_at`）——每天恰好
  一条评审记录，journal 里的安静不再可能被误读为「车道死了」，也顺带消除了 `too-few-sessions`
  在池长期单会话时每 30 分钟重复打日志的隐患。失败类跳过（`llm-off` / `llm-failed` /
  `invalid-output`）语义不变：不写戳、下个 tick 重试。
- README 拆分为双语：`README.md` 默认英文完整版，`README.zh-CN.md` 中文完整版，顶部互链；
  门面重写为记忆优先的叙事（项目记忆/本地向量/共享域在前，上下文管理在后），版本与测试数据
  同步刷新（0.10.1 / 上游 v0.49.30 / 宿主 0.2.2-rc.1 / 782 用例）。

### Added

- 设置卡片新增**两档生成路由钉**（维护 / 生成两类，均成对生效）：
  - `maintenance.verifyProvider` / `verifyModel` — 元数据类后台（verify/评分/自动归档分类/画像审阅）；
  - `historian.provider` / `model` — 生成类后台（historian 带外摘要 + `/compact` 摘要，此前只能跟随会话路由）。

  两组都从宿主已配置的模型目录（客户端 `remote.session.modelCatalog()`）下拉选择，带「Auto = 跟随
  会话路由」与一键清空；宿主不提供该 RPC 的 shell 退回纯文本输入（值仍可手填）。切换 provider 时自动
  清掉不属于它的旧 model 草稿；保存按「成对钉住 / 成对清空」写回，语义与 host 的 pin 判定一致
  （`maintenance-wiring.ts`、`liveRoute`：两者都非空才钉住）。`historian.{provider,model}` 现已由
  Config schema 声明，并在 pre-step、compaction engine、`/ctx-recomp` 三条路径上**实时读取**（改配置
  下一次调用即生效）；空值 = 保持原有「跟随会话」行为。

## [0.10.1] - 2026-11-05

**发布链路切换。** 本版本没有运行时代码变更，内容是把 npm 发布认证从一次性 token 切换到
npm Trusted Publishing（OIDC）：仓库不再保存任何 npm 凭据，发布由 GitHub Actions 的 OIDC
身份授权，provenance 签名保持不变（本版本即 trusted publisher 的首次验证发布）。

### Changed

- `.github/workflows/release.yml`：移除 `NODE_AUTH_TOKEN` 与 `NPM_TOKEN` secret 依赖，发布改由
  OIDC 授权；npmjs.com 的 trusted publisher 绑定到本仓库的 `release.yml`

## [0.10.0] - 2026-11-05

**首个 npm 制品版本。** 自 0.9.0 起的累积变更；从本版本开始，推送 `v*` tag 会由 GitHub Actions
跑完整门禁并自动发布到 npm 注册表（带 provenance 签名，可在 npm 页面验证来源）。

### Added

- 上游跟进：紧急回收（emergency）的 fit 护栏——估算出的表面用量装不下时保留原结果、不再重试
  （对齐上游 #731）
- 上游跟进：historian 无进展闸——会话历史没有更新时自动档等待下一个更新节点，`forcedRange`
  手动路径放行（对齐上游 #802）
- 上游跟进：`userObservations` 产出开关——画像收集器未装备时向 prompt 注入明确的 disabled
  说明，避免模型空转
- 发布流水线：`.github/workflows/release.yml`（tag 推送 → 版本 / 分支 / 重复发布三道护栏 →
  完整门禁 → `npm publish --provenance`）

### Changed

- **展示层命名统一**：全局域（原 machine）、工作域（原 org）的界面文案、路由选项、分类提示与
  `ctx_memory` 工具描述统一为新名称；内部 token（kind 值、`dir:global:*` 身份、`suggested_domain`
  列、classifier 词表）保持不变，历史记忆与 journal 零迁移
- 依赖：`vitest` 4.1.12、`@types/node` 24.19.2 及传递依赖刷新；CI 的 actions 升到 v7，
  dependabot 对 `@deepseek-ai/*` 宿主包与主版本升级改为人工处理

### Fixed

- reduce-guidance：nudge 记录的 turn 曾是硬编码 0，使同档位的粘性抑制间隔在 ≥5 轮会话里恒满足、
  热会话会在每个 system prompt 组装时重发提醒；改为记录真实用户轮数

## [0.9.0] - 2026-10-20

**首个公开发布。** 这是本适配器第一次以独立开源仓库的形式发布：此前它作为 magic-context 仓库的
`packages/dsh-plugin` 存在，于 2026-10-08 抽出为独立仓库。本条目只描述公开发布时仓库里已有的能力，
不追溯更早的仓库内部历史。

### Added

- 以 DSH bundle 形态安装的 Magic Context 插件，包含：
  - 可逆上下文回收：工具结果打 `§N§` 标签，`ctx_reduce` 只入队、在 execute 带内落地为
    `[dropped §N§]`，`ctx_expand` 恢复原文；
  - 压力调度：持久 usage → 压力评估 → execute / defer 决策，含 `CONTEXT_WINDOW_EXCEEDED` 紧急回收；
  - historian 带外摘要：一次性 LLM 调用重放真前缀，产出四层摘要与 facts / events，只写 store
    不动线缆，execute 带内发布为 `[compacted §C<n>§]`；
  - `m[0]`/`m[1]` 记忆基线：冻结基线 + 增量车道（`<new-memories>` / `<memory-updates>` /
    `<user-profile>`），内容未变则零变更；
  - 插件自有项目记忆库（`memories.db`，基于内建 `node:sqlite`），含 `ctx_memory` 检索与读写维护；
  - 本地向量检索车道：`vendor/` 内的 onnxruntime-web WASM 后端 + 钉死 revision / sha256 的
    MiniLM 下载，失败 fail-open 降级 FTS；
  - 机器 / 组织全局域与用户画像：入队可自动化，发布永远经人审批；
  - 30 分钟维护 tick（TTL 归档、LLM verify、向量回填、全域候选入队）；
  - 可接管的 `ctx.compaction` 压缩接缝（首装默认 `registerCompactionEngine: false`）；
  - GUI 集成：插件页设置卡片、`shell.overlay` 遥测徽标与胶囊面板、`session-notice` 会话流提示。
- 界面文案中英双语，`npm run check:i18n` 校验两侧字典一致。
- 公开的本地闸门：`npm run typecheck`、`npm test`、`npm run build`、`npm run check:i18n`，
  以及一次跑完的 `npm run gate`。
- 开源仓库配套文档：`README.md`、`docs/`、`CONTRIBUTING.md`、`SECURITY.md`、
  `CODE_OF_CONDUCT.md`、`NOTICE`、本 CHANGELOG，以及 GitHub issue / PR 模板与 CI 工作流。

### Notes

- 上游基线 **magic-context v0.46.0**（commit `651c105a9`，MIT）；本仓库新增部分 © 2026 wukai，
  整体以 MIT 发布，见 [LICENSE](LICENSE)。
- 运行环境：Node.js **>= 22.19**（依赖内建 `node:sqlite`，不引入原生模块）。已在 DSH
  **0.2.1-rc.1** 上用 Node 24.15 验证；CI 覆盖 Node 22.x 与 24.x。
- 插件数据目录沿用上游命名空间（`~/.local/share/cortexkit/magic-context-dsh-poc/`）以保持出处
  连续，自 2026-10-13 起与上游 MC 数据库分家，插件自有 `memories.db` 无共享兼容义务。

[Unreleased]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/wk544863858/dsh-plugin-magic-context/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/wk544863858/dsh-plugin-magic-context/releases/tag/v0.9.0
