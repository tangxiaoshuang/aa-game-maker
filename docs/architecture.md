# AI Web 游戏制作工具（AA Game Maker）架构设计文档

> 本文档固化项目核心技术方案：混合创作者工作台 + 2D 单机与实时多人联机 + 逻辑/渲染解耦 SDK + `workerd` V8 Isolate 权威房间沙箱 + ACP/MCP 本地与云端双模式 Agent Harness + 轻社区 Remix，并预留 3D 渲染扩展口。

---

## 1. 核心架构决策

| 维度 | 最终选型与边界 |
| :--- | :--- |
| **产品形态** | 混合创作者工作台（AI 对话驱动 + 数值热调 / 资产管理 / 双端预览 / 联机双窗与扫码调试 + 可选代码视图） |
| **首期游戏边界** | 2D 单机 + 2D 实时多人联机；架构预留 3D 渲染层扩展口（未来无缝接入 Three.js） |
| **联机架构** | 平台托管权威房间引擎（受限 Room 脚本 / 同构逻辑模式）：单机本地跑、联机无缝切 `workerd` 权威跑 |
| **游戏引擎底座** | 逻辑与渲染彻底解耦：纯 TS 无头逻辑层（内置轻量碰撞 + 可选 Matter.js / Rapier2D）+ PixiJS v8 渲染层 + 统一 Game SDK |
| **双端 UI 与操控** | 混合模式：联机大厅与移动端虚拟摇杆/按键由平台 HTML/CSS 壳层托管；主菜单/血条/计分板等 HUD 允许 AI 用 HTML 或 PixiJS 自由定制（受安全区与响应式约束） |
| **构建与隔离沙箱** | 浏览器端极速打包（`esbuild-wasm` + 独立安全域 `iframe`）+ **开源 `workerd` V8 Isolate 沙箱**（`workerLoader` 动态加载 + `globalOutbound: null` 零网络/零文件隔离） |
| **Agent 接入架构** | **双轨合规架构**：① 本地 ACP 模式采用 **Thin Editor 透传模式**（原话直达本地 Agent、通过工作区 `AGENTS.md`/`GEMINI.md` 与标准 MCP 暴露工具、不静默触发消费级 OAuth）；② 云端 / BYOK API Key 模式运行完整外层 Harness 编排（策划卡状态机 + 自动多轮修复） |
| **工作流节奏** | 建项目支持“轻量策划卡确认”与“极速直出”双入口，底层统一结构化 Spec；后续全走多轮对话增量 Diff |
| **自动验证闭环** | 三层轻量自检：L1 TS/打包检查 → L2 `workerd` 无头多玩家冒烟测试 → L3 `iframe` 运行态报错/404/黑屏采样自动修复 |
| **资产管线** | 分级混合管线：内置 CC0 素材库检索 + 程序化图形/Web Audio 合成音效 + 用户上传替换 + 按需 AI 生图去背，统一 `assets.json` |
| **源码主源与同步** | 云端不可变快照为主源 + Local Bridge 自动双向同步本地工作目录 |
| **发布与社区生态** | MVP 即含基础账号 + 一键发布直玩链接/二维码 + 版本快照回滚 + 导出源码/静态包 + 游戏广场/点赞收藏/一键 Fork & Remix |
| **全栈工程与基建** | TypeScript Monorepo（`pnpm` + `Turborepo`）：Next.js + 独立沙箱播放器 + Fastify/WebSocket + `workerd` + Podman（PostgreSQL / Redis / RustFS S3） |

---

## 2. 系统分层与数据流

```text
[浏览器端 Web 工作台 apps/web :3000]
  ├── 策划卡 / 对话 / 文件树 / 数值热调面板 / 资产面板 / 社区广场
  ├── 浏览器端 esbuild-wasm 打包器（产出 clientBundle + simBundle）
  ├── L1/L2/L3 一键校验器
  └── 独立源沙箱 iframe [apps/player :3001]（支持 PC / 手机竖横屏 / 双窗联机 / 扫码真机）
          │
          │ WebSocket (房间同步协议: join / input / snapshot / event)
          ▼
[权威联机房间服务 apps/room-server :4000]
  ├── Fastify + WebSocket 网关 / 房间生命周期与 20Hz Tick 调度
  ├── Redis 房间状态路由 / 元数据
  └── 开源 workerd V8 Isolate 沙箱进程 (:4001 内部回环)
        └── workerLoader 动态加载各游戏 simulation.js（globalOutbound: null，零网络/文件系统权限）

[可选：本机 Local Bridge packages/local-bridge]
  └── WebSocket ⇄ Web 工作台 | ACP (stdio) ⇄ 本地 Agent | 暴露 Game Harness MCP Server + 双向目录同步

[本地/自托管基础设施 Podman docker/compose.yml]
  ├── PostgreSQL 16 (:5432)  — 用户 / 项目 / 内容寻址快照 / 发布 / 社区点赞与 Remix
  ├── Redis 7      (:6379)   — 房间路由 / 在线态 / 限流
  └── RustFS S3    (:9000/:9001) — CC0 素材库 / 上传资源 / 发布产物对象存储
```

---

## 3. 游戏工程标准契约（`packages/game-sdk`）

每个游戏项目统一遵循以下逻辑/表现解耦结构：

- `spec.json`：结构化策划卡（标题、玩法摘要、单机/联机模式、屏幕方向、最大人数、控制槽位）
- `config.ts`：带类型与范围定义的数值表（工作台自动渲染实时滑块面板）
- `assets.json`：统一资产清单（CC0 ID / 程序化音效参数 / 自定义上传或生图 URL）
- `simulation.ts`：纯 TypeScript 无头仿真逻辑（导出 `createSimulation()`，实现 `init` / `onPlayerJoin` / `onPlayerLeave` / `onInput` / `onTick`，严格禁止 DOM/Window/随机非确定源）
- `renderer.ts`：客户端表现层（基于 PixiJS v8 渲染世界状态、线性插值平滑、可选自定义 HUD 与程序化音效触发）

---

## 4. 实施里程碑

- **Milestone 1（当前阶段）**：Monorepo 脚手架 + Podman 本地基建 + `protocol` / `game-sdk` + 2 个黄金模板（2D 单机 & 2D 实时多人）+ `workerd` 权威房间引擎 + 独立源 `player` 沙箱 + `web` 工作台（浏览器端 `esbuild-wasm` 实时编译、双端视口、数值热调、双窗联机测试、手机扫码同房、L1~L3 自检）。
- **Milestone 2**：`harness-core` / `harness-mcp` / `local-bridge`（ACP 接入本地 Agent + 双向目录同步）+ 内置云端/BYOK 模式 + 策划卡确认/极速直出双入口 + CC0 资产检索。
- **Milestone 3**：账号持久化、云端内容寻址快照回滚、一键发布（短链+静态/源码导出）、社区广场与一键 Fork/Remix、按需 AI 生图去背。
- **Milestone 4**：3D 渲染扩展（Three.js）、L4 VLM 多视口视觉巡检、进阶物理与排行榜 BaaS。
