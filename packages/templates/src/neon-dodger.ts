import type { AssetManifest, ConfigParam, GameSpec } from "@aa-game/protocol";
import { getDefaultConfigValues, type TemplateProject } from "./types.js";

const spec: GameSpec = {
  id: "neon-dodger",
  title: "Neon Star Dodger",
  description:
    "2D 单机霓虹闪避与收集挑战：操控飞船在不断加速的陨石雨中收集能量星，按冲刺获得短暂无敌，适配 PC 键鼠与手机虚拟摇杆。",
  mode: "singleplayer",
  orientation: "portrait",
  worldSize: { width: 540, height: 840 },
  maxPlayers: 1,
  minPlayersToStart: 1,
  tickRate: 30,
  controls: {
    joystick: true,
    pointer: false,
    buttons: [
      { id: "primary", label: "冲刺", keyHint: "Space", color: "#38bdf8" },
    ],
  },
  hudMode: "hybrid",
};

const configSchema: ConfigParam[] = [
  {
    key: "playerSpeed",
    label: "飞船移速",
    type: "number",
    defaultValue: 300,
    min: 140,
    max: 520,
    step: 10,
    description: "飞船基础移动速度 (px/s)",
  },
  {
    key: "dashMultiplier",
    label: "冲刺倍率",
    type: "number",
    defaultValue: 2.3,
    min: 1.4,
    max: 3.5,
    step: 0.1,
  },
  {
    key: "hazardRate",
    label: "陨石生成速率",
    type: "number",
    defaultValue: 1.4,
    min: 0.5,
    max: 3.5,
    step: 0.1,
  },
  {
    key: "hazardSpeed",
    label: "陨石下落速度",
    type: "number",
    defaultValue: 220,
    min: 100,
    max: 480,
    step: 10,
  },
  {
    key: "lives",
    label: "初始生命值",
    type: "number",
    defaultValue: 3,
    min: 1,
    max: 5,
    step: 1,
  },
];

const assets: AssetManifest = {
  version: 1,
  assets: [
    { id: "sfx_coin", kind: "procedural_sfx", source: "procedural", sfxPreset: "coin" },
    { id: "sfx_dash", kind: "procedural_sfx", source: "procedural", sfxPreset: "dash" },
    { id: "sfx_hit", kind: "procedural_sfx", source: "procedural", sfxPreset: "hit" },
    { id: "sfx_lose", kind: "procedural_sfx", source: "procedural", sfxPreset: "lose" },
  ],
};

const simulationCode = `import { clamp, circleOverlap } from "@aa-game/game-sdk/headless";

export interface DodgerState {
  status: "playing" | "gameover";
  score: number;
  bestScore: number;
  lives: number;
  elapsedSec: number;
  player: {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    dashTimer: number;
    dashCooldown: number;
    invulnTimer: number;
  };
  stars: Array<{ id: number; x: number; y: number; radius: number; pulse: number }>;
  hazards: Array<{ id: number; x: number; y: number; vx: number; vy: number; radius: number }>;
  spawnAccum: number;
  nextId: number;
  inputs: Record<string, { moveX: number; moveY: number; primary: boolean }>;
}

export function createSimulation() {
  return {
    init(ctx: any): DodgerState {
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;
      const lives = Number(ctx.config.lives ?? 3);
      return {
        status: "playing",
        score: 0,
        bestScore: 0,
        lives,
        elapsedSec: 0,
        player: {
          id: "local",
          x: w * 0.5,
          y: h * 0.78,
          vx: 0,
          vy: 0,
          radius: 18,
          dashTimer: 0,
          dashCooldown: 0,
          invulnTimer: 0,
        },
        stars: [
          { id: 1, x: w * 0.3, y: h * 0.35, radius: 13, pulse: 0 },
          { id: 2, x: w * 0.72, y: h * 0.52, radius: 13, pulse: 1.5 },
        ],
        hazards: [],
        spawnAccum: 0,
        nextId: 10,
        inputs: {},
      };
    },

    onPlayerJoin(state: DodgerState, player: { id: string }) {
      state.player.id = player.id;
    },

    onPlayerLeave() {},

    onInput(state: DodgerState, playerId: string, input: any) {
      state.inputs[playerId] = {
        moveX: clamp(Number(input.moveX || 0), -1, 1),
        moveY: clamp(Number(input.moveY || 0), -1, 1),
        primary: Boolean(input.primary),
      };
    },

    onTick(state: DodgerState, ctx: any) {
      const dt = ctx.dt;
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;
      const input = state.inputs[state.player.id] ?? { moveX: 0, moveY: 0, primary: false };

      if (state.status === "gameover") {
        if (input.primary) {
          const prevBest = Math.max(state.bestScore, state.score);
          const fresh = this.init(ctx);
          fresh.bestScore = prevBest;
          fresh.player.id = state.player.id;
          fresh.inputs = {};
          Object.assign(state, fresh);
          ctx.emit("sfx", { preset: "click" });
        }
        return;
      }

      state.elapsedSec += dt;
      const p = state.player;
      p.dashTimer = Math.max(0, p.dashTimer - dt);
      p.dashCooldown = Math.max(0, p.dashCooldown - dt);
      p.invulnTimer = Math.max(0, p.invulnTimer - dt);

      if (input.primary && p.dashCooldown <= 0) {
        p.dashTimer = 0.22;
        p.dashCooldown = 1.1;
        p.invulnTimer = Math.max(p.invulnTimer, 0.28);
        ctx.emit("sfx", { preset: "dash" });
      }

      const baseSpeed = Number(ctx.config.playerSpeed ?? 300);
      const dashMult = p.dashTimer > 0 ? Number(ctx.config.dashMultiplier ?? 2.3) : 1;
      p.vx = input.moveX * baseSpeed * dashMult;
      p.vy = input.moveY * baseSpeed * dashMult;
      p.x = clamp(p.x + p.vx * dt, p.radius + 10, w - p.radius - 10);
      p.y = clamp(p.y + p.vy * dt, p.radius + 76, h - p.radius - 14);

      const difficulty = 1 + state.elapsedSec * 0.025;
      const rate = Number(ctx.config.hazardRate ?? 1.4) * difficulty;
      state.spawnAccum += dt * rate;
      while (state.spawnAccum >= 1) {
        state.spawnAccum -= 1;
        const speed = Number(ctx.config.hazardSpeed ?? 220) * difficulty * ctx.rng.range(0.85, 1.25);
        state.hazards.push({
          id: state.nextId++,
          x: ctx.rng.range(24, w - 24),
          y: -24,
          vx: ctx.rng.range(-48, 48),
          vy: speed,
          radius: ctx.rng.range(12, 22),
        });
      }

      for (let i = state.hazards.length - 1; i >= 0; i -= 1) {
        const hz = state.hazards[i]!;
        hz.x += hz.vx * dt;
        hz.y += hz.vy * dt;
        if (hz.x < hz.radius || hz.x > w - hz.radius) hz.vx *= -1;
        if (hz.y > h + 40) {
          state.hazards.splice(i, 1);
          continue;
        }
        if (p.invulnTimer <= 0 && circleOverlap(p.x, p.y, p.radius - 2, hz.x, hz.y, hz.radius - 2)) {
          state.hazards.splice(i, 1);
          state.lives -= 1;
          p.invulnTimer = 1.1;
          if (state.lives <= 0) {
            state.status = "gameover";
            state.bestScore = Math.max(state.bestScore, state.score);
            ctx.emit("sfx", { preset: "lose" });
          } else {
            ctx.emit("sfx", { preset: "hit" });
          }
        }
      }

      for (const star of state.stars) {
        star.pulse += dt * 4.2;
        if (circleOverlap(p.x, p.y, p.radius + 4, star.x, star.y, star.radius)) {
          state.score += 10;
          star.x = ctx.rng.range(48, w - 48);
          star.y = ctx.rng.range(110, h - 140);
          ctx.emit("sfx", { preset: "coin" });
        }
      }
    },
  };
}
`;

const rendererCode = `import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { lerpPos } from "@aa-game/game-sdk";

export function createRenderer() {
  let bgGfx: Graphics;
  let entityLayer: Container;
  let shipTex: Texture;
  let dashShipTex: Texture;
  let starTex: Texture;
  let hazardTex: Texture;
  let playerSprite: Sprite;
  const starPool: Sprite[] = [];
  const hazardPool: Sprite[] = [];
  const prevHazardMap = new Map<number, { x: number; y: number }>();

  let hudEl: HTMLDivElement;
  let scoreEl: HTMLSpanElement;
  let bestEl: HTMLSpanElement;
  let heartsEl: HTMLSpanElement;
  let dashEl: HTMLSpanElement;
  let gameoverEl: HTMLDivElement;
  let finalScoreEl: HTMLDivElement;

  let lastScore = -1;
  let lastBest = -1;
  let lastLives = -1;
  let lastDashText = "";
  let lastStatus = "";

  function bakeCircleTex(app: any, outerR: number, layers: Array<{ r: number; color: number; alpha?: number; ox?: number; oy?: number }>): Texture {
    const g = new Graphics();
    for (const l of layers) {
      g.circle(outerR + (l.ox ?? 0), outerR + (l.oy ?? 0), l.r).fill({ color: l.color, alpha: l.alpha ?? 1 });
    }
    const tex = app.renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    return tex;
  }

  function ensureSprite(pool: Sprite[], idx: number, tex: Texture): Sprite {
    let sp = pool[idx];
    if (!sp) {
      sp = new Sprite(tex);
      sp.anchor.set(0.5);
      entityLayer.addChild(sp);
      pool[idx] = sp;
    }
    sp.visible = true;
    return sp;
  }

  return {
    init(ctx: any) {
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;

      // 1. Static background & neon grid drawn ONCE and cached as a single GPU texture
      bgGfx = new Graphics();
      bgGfx.rect(0, 0, w, h).fill({ color: 0x070b18 });
      const gridStep = 45;
      for (let x = gridStep; x < w; x += gridStep) {
        bgGfx.moveTo(x, 0).lineTo(x, h).stroke({ color: 0x1e293b, width: 1, alpha: 0.45 });
      }
      for (let y = gridStep; y < h; y += gridStep) {
        bgGfx.moveTo(0, y).lineTo(w, y).stroke({ color: 0x1e293b, width: 1, alpha: 0.45 });
      }
      if (typeof bgGfx.cacheAsTexture === "function") {
        bgGfx.cacheAsTexture(true);
      }
      ctx.worldLayer.addChild(bgGfx);

      // 2. Pre-bake entity textures once (zero per-frame Graphics triangulation)
      starTex = bakeCircleTex(ctx.app, 22, [
        { r: 20, color: 0xfacc15, alpha: 0.22 },
        { r: 13, color: 0xfde047 },
        { r: 6, color: 0xffffff },
      ]);
      hazardTex = bakeCircleTex(ctx.app, 28, [
        { r: 26, color: 0xf43f5e, alpha: 0.22 },
        { r: 20, color: 0xfb7185 },
        { r: 6.5, color: 0xffe4e6, alpha: 0.65, ox: -5, oy: -5 },
      ]);
      shipTex = bakeCircleTex(ctx.app, 32, [
        { r: 26, color: 0x38bdf8, alpha: 0.25 },
        { r: 18, color: 0x38bdf8 },
        { r: 9, color: 0xe0f2fe },
      ]);
      dashShipTex = bakeCircleTex(ctx.app, 36, [
        { r: 34, color: 0x22d3ee, alpha: 0.3 },
        { r: 18, color: 0x22d3ee },
        { r: 9, color: 0xe0f2fe },
      ]);

      entityLayer = new Container();
      ctx.worldLayer.addChild(entityLayer);

      playerSprite = new Sprite(shipTex);
      playerSprite.anchor.set(0.5);
      entityLayer.addChild(playerSprite);

      // 3. Build HUD DOM nodes ONCE and update only changed textContent (dirty-checked)
      hudEl = document.createElement("div");
      hudEl.style.cssText =
        "position:absolute;top:max(12px,env(safe-area-inset-top));left:14px;right:14px;display:flex;justify-content:space-between;align-items:center;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;color:#f8fafc;z-index:15;";

      const leftBox = document.createElement("div");
      leftBox.style.cssText =
        "background:rgba(15,23,42,0.72);border:1px solid rgba(56,189,248,0.4);padding:6px 12px;border-radius:10px;font-weight:700;font-size:14px;";
      leftBox.append("得分 ");
      scoreEl = document.createElement("span");
      scoreEl.style.color = "#fde047";
      leftBox.appendChild(scoreEl);
      bestEl = document.createElement("span");
      bestEl.style.cssText = "margin-left:10px;color:#94a3b8;font-size:12px;";
      leftBox.appendChild(bestEl);

      const rightBox = document.createElement("div");
      rightBox.style.cssText =
        "background:rgba(15,23,42,0.72);border:1px solid rgba(244,63,94,0.4);padding:6px 12px;border-radius:10px;font-weight:700;font-size:14px;";
      heartsEl = document.createElement("span");
      heartsEl.style.cssText = "color:#fb7185;letter-spacing:2px;";
      dashEl = document.createElement("span");
      dashEl.style.cssText = "margin-left:10px;color:#38bdf8;font-size:12px;";
      rightBox.append(heartsEl, dashEl);

      gameoverEl = document.createElement("div");
      gameoverEl.style.cssText =
        "position:fixed;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;";
      const card = document.createElement("div");
      card.style.cssText =
        "background:rgba(7,11,24,0.88);border:1px solid rgba(56,189,248,0.5);padding:20px 28px;border-radius:16px;text-align:center;";
      const overTitle = document.createElement("div");
      overTitle.style.cssText = "font-size:24px;font-weight:800;color:#f8fafc;";
      overTitle.textContent = "挑战结束";
      finalScoreEl = document.createElement("div");
      finalScoreEl.style.cssText = "margin-top:8px;font-size:16px;color:#fde047;";
      const hint = document.createElement("div");
      hint.style.cssText = "margin-top:10px;font-size:13px;color:#94a3b8;";
      hint.textContent = "按 Space 或点击“冲刺”再来一局";
      card.append(overTitle, finalScoreEl, hint);
      gameoverEl.appendChild(card);

      hudEl.append(leftBox, rightBox, gameoverEl);
      ctx.hudDomRoot.appendChild(hudEl);
    },

    onEvent(ev: any, ctx: any) {
      if (ev.type === "sfx" && ev.payload?.preset) {
        ctx.audio.play(ev.payload.preset);
      }
    },

    render(state: any, prevState: any, alpha: number) {
      // Collectible energy stars (pooled sprites)
      const stars = state.stars ?? [];
      for (let i = 0; i < stars.length; i += 1) {
        const star = stars[i]!;
        const sp = ensureSprite(starPool, i, starTex);
        const pulse = 1 + Math.sin(star.pulse) * 0.16;
        sp.position.set(star.x, star.y);
        sp.scale.set((star.radius / 13) * pulse);
      }
      for (let i = stars.length; i < starPool.length; i += 1) {
        starPool[i]!.visible = false;
      }

      // Hazards (O(1) Map lookup + pooled sprites)
      prevHazardMap.clear();
      const prevHazards = prevState?.hazards;
      if (prevHazards) {
        for (let i = 0; i < prevHazards.length; i += 1) {
          const item = prevHazards[i]!;
          prevHazardMap.set(item.id, item);
        }
      }
      const hazards = state.hazards ?? [];
      for (let i = 0; i < hazards.length; i += 1) {
        const hz = hazards[i]!;
        const sp = ensureSprite(hazardPool, i, hazardTex);
        const pos = lerpPos(prevHazardMap.get(hz.id), hz, alpha);
        sp.position.set(pos.x, pos.y);
        sp.scale.set(hz.radius / 20);
      }
      for (let i = hazards.length; i < hazardPool.length; i += 1) {
        hazardPool[i]!.visible = false;
      }

      // Player ship
      const p = state.player;
      if (p) {
        const pos = lerpPos(prevState?.player, p, alpha);
        const blink = p.invulnTimer > 0 && Math.floor(p.invulnTimer * 18) % 2 === 0;
        playerSprite.visible = !blink;
        if (!blink) {
          const targetTex = p.dashTimer > 0 ? dashShipTex : shipTex;
          if (playerSprite.texture !== targetTex) playerSprite.texture = targetTex;
          playerSprite.position.set(pos.x, pos.y);
        }
      }

      // Dirty-checked HUD updates (0 DOM writes when unchanged)
      const score = state.score ?? 0;
      const best = Math.max(state.bestScore ?? 0, score);
      const lives = Math.max(0, state.lives ?? 0);
      const dashText = (p?.dashCooldown ?? 0) <= 0.01 ? "冲刺就绪" : \`冷却 \${p.dashCooldown.toFixed(1)}s\`;
      const status = state.status ?? "playing";

      if (score !== lastScore) {
        lastScore = score;
        scoreEl.textContent = String(score);
      }
      if (best !== lastBest) {
        lastBest = best;
        bestEl.textContent = \`最高 \${best}\`;
      }
      if (lives !== lastLives) {
        lastLives = lives;
        heartsEl.textContent = "♥".repeat(lives) || "0";
      }
      if (dashText !== lastDashText) {
        lastDashText = dashText;
        dashEl.textContent = dashText;
      }
      if (status !== lastStatus) {
        lastStatus = status;
        gameoverEl.style.display = status === "gameover" ? "flex" : "none";
        if (status === "gameover") {
          finalScoreEl.textContent = \`本局得分：\${score}\`;
        }
      }
    },

    destroy() {
      bgGfx?.destroy();
      entityLayer?.destroy({ children: true });
      shipTex?.destroy(true);
      dashShipTex?.destroy(true);
      starTex?.destroy(true);
      hazardTex?.destroy(true);
      hudEl?.remove();
    },
  };
}
`;

export const neonDodgerTemplate: TemplateProject = {
  id: spec.id,
  name: spec.title,
  tagline: "2D 单机 · 竖屏霓虹闪避与收集（含冲刺、程序化音效、实时滑块调参）",
  spec,
  configSchema,
  defaultConfig: getDefaultConfigValues(configSchema),
  assets,
  files: {
    "spec.json": JSON.stringify(spec, null, 2),
    "config.json": JSON.stringify(getDefaultConfigValues(configSchema), null, 2),
    "assets.json": JSON.stringify(assets, null, 2),
    "simulation.ts": simulationCode,
    "renderer.ts": rendererCode,
  },
};
