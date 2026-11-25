# Another AI Game Maker

> AI 驱动的 Web 游戏创作工作台 —— 面向 **2D 单机与实时多人联机** Web 游戏，开箱支持 **PC 与移动端双端体验**，基于开源 **`workerd` V8 Isolate** 权威房间沙箱与 **ACP / MCP + BYOK** 双轨 Agent 架构。

详细架构设计见 [docs/architecture.md](./docs/architecture.md)。

## 核心特性

- **逻辑 / 渲染彻底解耦**：纯 TypeScript 无头仿真层（`simulation.ts`）+ PixiJS v8 渲染层（`renderer.ts`），单机本地运行、联机无缝切入服务端权威执行，架构预留 3D（Three.js）扩展口。
- **开源 `workerd` 权威联机房间**：基于 `workerd` `workerLoader` 动态隔离各游戏房间（`globalOutbound: null` 零出站网络），支持工作台双窗分屏联机与**手机扫码同房真机对战**。
- **双端适配开箱即用**：内置 PC 键鼠 + 移动端 HTML/CSS 虚拟摇杆与联机大厅壳层、安全区适配与 Web Audio 程序化音效（自动处理 iOS 首次手势解锁）。
- **双轨 AI Agent 接入**：
  - **本地 ACP 模式（Thin Editor）**：通过 `local-bridge` 原话透传接入本机 `agy acp` / `gemini --acp` / `claude-code-acp` / `goose` / `codex-acp`，自动生成 `AGENTS.md`（及 `@AGENTS.md` 引用的 `CLAUDE.md` / `GEMINI.md`）并挂载标准 `aa-game-harness` MCP Server 与双向目录同步。
  - **云端 / BYOK 模式**：内置多轮工具调用 Harness，支持「轻量策划卡确认」与「极速直出」双入口及 L1~L3 三层自动校验自修。
- **完整创作与社区闭环**：浏览器端 `esbuild-wasm` 毫秒级热编、数值滑块实时热调、PostgreSQL 内容寻址快照与一键回滚、RustFS S3 素材上传与去背精灵生成、单文件 HTML / 源码 Zip 导出，以及社区广场（`/gallery`）、独立直玩页（`/play/[slug]`）与一键 **Fork / Remix**。

## 目录结构

```text
aa-game-maker/
├── apps/
│   ├── web/           # Next.js 创作者工作台 + 社区广场 (/gallery) + 独立游玩页 (/play/[slug])
│   ├── player/        # 独立安全域游戏运行沙箱（PixiJS + HTML 双端虚拟操控与联机大厅）
│   ├── api/           # Fastify 平台业务服务（账号 / PostgreSQL 快照 / RustFS S3 / Remix / 导出）
│   └── room-server/   # Fastify WebSocket 权威房间网关 + 开源 workerd V8 Isolate 沙箱引擎
├── packages/
│   ├── protocol/      # 共享协议与 Zod Schema（Spec / Assets / Config / Room / ACP / Platform）
│   ├── game-sdk/      # 同构游戏 SDK（无头逻辑契约 / 碰撞 / 插值 / Web Audio / 双端输入）
│   ├── templates/     # 黄金参考模板（2D 单机 Neon Star Dodger + 2D 多人 Star Dash Arena）
│   ├── harness-core/  # 统一游戏 Harness（Skill 规范 / 双语 CC0 素材库 / L1-L3 自检 / 云端 Agent）
│   ├── harness-mcp/   # 标准 stdio MCP Server（暴露游戏工具与资源）
│   └── local-bridge/  # 本地 ACP Bridge CLI（ws://127.0.0.1:4318 + Origin/Token 鉴权 + 双向同步）
├── docker/
│   └── compose.yml    # Podman 本地基础设施（PostgreSQL 16 / Redis 7 / RustFS S3）
└── docs/
    └── architecture.md
```

## 快速启动

1. **启动本地基础设施（Podman）**
   ```bash
   cp .env.example .env
   podman compose -f docker/compose.yml up -d
   ```

2. **安装依赖与构建**
   ```bash
   corepack pnpm install
   corepack pnpm build
   ```

3. **启动开发环境**
   ```bash
   corepack pnpm dev
   ```
   - 创作者工作台：`http://localhost:3000`
   - 社区游戏广场：`http://localhost:3000/gallery`
   - 独立沙箱播放器：`http://localhost:3001`
   - 权威联机房间服务（`workerd`）：`http://localhost:4000/health`
   - 平台业务 API（PostgreSQL + RustFS S3）：`http://localhost:4002/health`

4. **可选：启动本地 ACP Bridge（接入 `agy acp` / `gemini --acp` / `claude-code-acp` 等）**
   ```bash
   corepack pnpm bridge
   ```
   复制终端显示的 `Pairing Token`，在工作台左侧「🤖 AI 创作 → 🔌 本地 ACP Agent」连接即可。

## 常用命令

```bash
corepack pnpm build       # 构建全部 workspace 子包
corepack pnpm typecheck   # 全量 TypeScript 类型检查
corepack pnpm test        # 运行 Harness / workerd 联机 / Local Bridge / 平台 API 端到端测试
```
