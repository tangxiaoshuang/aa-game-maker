import type { CreationWorkflowMode } from "@aa-game/protocol";

export const GAME_DEV_SKILL_MD = `# AA Game Maker — Decoupled 2D Singleplayer & Multiplayer Game Skill

You are developing a Web 2D game inside the **AA Game Maker** runtime harness.
Follow these strict architectural invariants so games run smoothly on **both PC and Mobile** and execute safely inside the **open-source workerd V8 Isolate authoritative room engine**.

## 1. Standard Project File Layout
- \`spec.json\`: Structured GameSpec (title, description, mode: "singleplayer" | "multiplayer", orientation: "portrait" | "landscape" | "responsive", worldSize, maxPlayers, tickRate, controls, hudMode).
- \`config.json\`: Tunable gameplay balance numbers/booleans (exposed as live sliders in the Workbench).
- \`assets.json\`: AssetManifest ({ version: 1, assets: [...] }). NEVER hardcode external image URLs; register assets via \`game_search_assets\` + \`game_register_asset\`.
- \`simulation.ts\`: Pure TypeScript headless game logic exporting \`export function createSimulation()\`.
- \`renderer.ts\`: Client PixiJS v8 + HTML HUD renderer exporting \`export function createRenderer()\`.

## 2. Hard Invariants for \`simulation.ts\` (workerd V8 Isolate Rules)
1. **ZERO DOM / Pixi / Network imports**: Only import from \`"@aa-game/game-sdk/headless"\` (exports: \`clamp\`, \`lerp\`, \`distance\`, \`normalize\`, \`circleOverlap\`, \`aabbOverlap\`, \`SeededRng\`). Never import \`pixi.js\`, \`window\`, \`document\`, or \`fetch\`.
2. **Deterministic simulation**: Use \`ctx.rng.next() / range() / int() / pick()\` instead of \`Math.random()\`, and \`ctx.dt\` / \`ctx.elapsedMs\` instead of \`Date.now()\`.
3. **Simulation methods**:
   - \`init(ctx)\`: returns JSON-serializable state object.
   - \`onPlayerJoin(state, player, ctx)\`: registers a player (\`{ id, name, color }\`).
   - \`onPlayerLeave(state, playerId, ctx)\`: cleanly removes player and input.
   - \`onInput(state, playerId, input, ctx)\`: stores normalized input (\`moveX, moveY, primary, secondary\`).
   - \`onTick(state, ctx)\`: advances state by \`ctx.dt\`. Emit SFX via \`ctx.emit("sfx", { preset: "coin" | "dash" | "hit" | "jump" | "explosion" | "win" | "lose" | "click" })\`.
   - Optional \`onConfigUpdate(state, config, ctx)\` & \`getPublicState(state)\`.
4. **Finite numbers only**: Never leave \`NaN\` or \`Infinity\` in state (always guard divisions by zero!).

## 3. Hard Invariants for \`renderer.ts\` (PC + Mobile Dual-Platform)
1. Import PixiJS v8 symbols from \`"pixi.js"\` (e.g. \`Graphics\`, \`Container\`, \`Text\`) and helpers from \`"@aa-game/game-sdk"\` (\`lerpPos\`, \`lerp\`).
2. **PixiJS v8 Graphics API**: Use \`gfx.rect(x, y, w, h).fill({ color })\`, \`gfx.circle(x, y, r).fill({ color })\`, \`gfx.moveTo(x1,y1).lineTo(x2,y2).stroke({ color, width })\` (NOT PixiJS v7 \`beginFill/drawCircle\`!).
3. **Hybrid UI / Safe Areas**:
   - Multiplayer lobby and mobile virtual joystick/buttons are mounted by the platform shell automatically.
   - Render score/lives/timer/game-over HUD inside \`ctx.hudDomRoot\` with \`pointer-events:none\` and \`top: max(12px, env(safe-area-inset-top))\` so mobile notches and virtual controls at the bottom are never obstructed!
4. **Smooth Interpolation**: Always use \`lerpPos(prevEntity, currEntity, alpha)\` for moving entities so 20Hz networked snapshots render at 60fps.
5. **Clean Teardown**: Implement \`destroy()\` to remove DOM nodes and destroy Graphics.

## 4. Mandatory Verification Self-Repair Loop
After making code changes, ALWAYS call \`game_verify\`.
- It executes **L1 compile check** (esbuild), **L2 workerd V8 isolate 120-tick smoke test** (checking crashes, NaN, tick budget, snapshot size), and optionally **L3 iframe canvas probe**.
- If \`game_verify\` reports any error, fix the root cause and re-run \`game_verify\` until it passes (up to 3 repair attempts) before concluding.
`;

export function buildHarnessUserPrompt(params: {
  phase: "spec" | "implement" | "iterate" | "fix";
  workflowMode: CreationWorkflowMode;
  prompt: string;
  specJson?: string;
  fileList: string[];
}): string {
  const filesSummary = params.fileList.join(", ");

  if (params.phase === "spec" && params.workflowMode === "spec-confirm") {
    return [
      `[工作流阶段: 轻量策划卡生成 (spec-confirm Phase 1)]`,
      `当前工程文件: ${filesSummary}`,
      `用户需求: ${params.prompt}`,
      ``,
      `请完成以下动作后立即停止（本阶段暂不编写 simulation.ts / renderer.ts 代码，等待用户确认策划卡）：`,
      `1. 调用 game_search_assets 检索匹配主题的 CC0 图形或程序化音效，并用 game_register_asset 注册所需资产。`,
      `2. 调用 game_update_spec 写入结构化策划卡 spec.json（明确单机/联机 mode、屏幕方向 orientation、worldSize、maxPlayers 与双端 controls）。`,
      `3. 调用 game_update_config 写入核心可调参数 config.json。`,
      `4. 用简洁中文向用户概括核心玩法循环、PC/移动端操作方式、联机同步设计（若为联机），提示用户可在策划卡中微调或点击“确认并生成代码”。`,
    ].join("\n");
  }

  if (params.phase === "implement") {
    return [
      `[工作流阶段: 按已确认策划卡实现可玩版本 (Phase 2)]`,
      `当前工程文件: ${filesSummary}`,
      params.specJson ? `已确认的 spec.json:\n${params.specJson}` : "",
      `补充要求: ${params.prompt || "按策划卡完整实现 simulation.ts 与 renderer.ts"}`,
      ``,
      `请完成以下动作：`,
      `1. 实现纯无头逻辑 simulation.ts 与双端自适应 PixiJS 渲染层 renderer.ts。`,
      `2. 务必调用 game_verify 执行 L1 编译 + L2 workerd 权威无头冒烟自检；若发现报错或 NaN，立即修复并复验直至通过。`,
      `3. 完成后简明汇报实现亮点、操作说明与校验结果。`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (params.phase === "fix") {
    return [
      `[工作流阶段: 自动定位与修复报错 (fix)]`,
      `当前工程文件: ${filesSummary}`,
      `错误上下文: ${params.prompt}`,
      ``,
      `请先用 game_read_file 读取相关源码，用 game_apply_patch（或 game_write_file）精准修复根因，然后调用 game_verify 复验直至全部通过。`,
    ].join("\n");
  }

  // fast-direct or iterate
  return [
    `[工作流阶段: ${params.workflowMode === "fast-direct" && params.phase === "spec" ? "极速直出初版 (fast-direct)" : "多轮增量迭代 (iterate)"}]`,
    `当前工程文件: ${filesSummary}`,
    `用户需求: ${params.prompt}`,
    ``,
    `请先用 game_get_project_state / game_read_file 了解现状，按需更新 spec.json / config.json / assets.json 及增量修改 simulation.ts / renderer.ts，最后务必调用 game_verify 通过 L1+L2 自检后再回复用户。`,
  ].join("\n");
}
