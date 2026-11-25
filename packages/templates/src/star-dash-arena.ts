import type { AssetManifest, ConfigParam, GameSpec } from "@aa-game/protocol";
import { getDefaultConfigValues, type TemplateProject } from "./types.js";

const spec: GameSpec = {
  id: "star-dash-arena",
  title: "Star Dash Arena (联机对战)",
  description:
    "2D 实时多人竞技：2~4 名玩家同场争夺竞技场内随机刷新的高能星核，冲刺撞击对手可击落对方星核。同一份 simulation.ts 运行在开源 workerd V8 Isolate 权威房间中！",
  mode: "multiplayer",
  orientation: "landscape",
  worldSize: { width: 900, height: 560 },
  maxPlayers: 4,
  minPlayersToStart: 1,
  tickRate: 20,
  controls: {
    joystick: true,
    pointer: false,
    buttons: [
      { id: "primary", label: "冲撞", keyHint: "Space", color: "#34d399" },
    ],
  },
  hudMode: "hybrid",
};

const configSchema: ConfigParam[] = [
  {
    key: "moveSpeed",
    label: "角色移速",
    type: "number",
    defaultValue: 260,
    min: 140,
    max: 460,
    step: 10,
  },
  {
    key: "dashForce",
    label: "冲撞爆发倍率",
    type: "number",
    defaultValue: 2.5,
    min: 1.5,
    max: 4.0,
    step: 0.1,
  },
  {
    key: "roundSeconds",
    label: "单局时长 (秒)",
    type: "number",
    defaultValue: 60,
    min: 20,
    max: 180,
    step: 10,
  },
  {
    key: "starCount",
    label: "场内星核数量",
    type: "number",
    defaultValue: 7,
    min: 3,
    max: 16,
    step: 1,
  },
  {
    key: "knockback",
    label: "碰撞击退力度",
    type: "number",
    defaultValue: 340,
    min: 100,
    max: 650,
    step: 20,
  },
];

const assets: AssetManifest = {
  version: 1,
  assets: [
    { id: "sfx_coin", kind: "procedural_sfx", source: "procedural", sfxPreset: "coin" },
    { id: "sfx_dash", kind: "procedural_sfx", source: "procedural", sfxPreset: "dash" },
    { id: "sfx_hit", kind: "procedural_sfx", source: "procedural", sfxPreset: "hit" },
    { id: "sfx_win", kind: "procedural_sfx", source: "procedural", sfxPreset: "win" },
  ],
};

const simulationCode = `import { clamp, circleOverlap, distance } from "@aa-game/game-sdk/headless";

export interface ArenaPlayer {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kbX: number;
  kbY: number;
  radius: number;
  score: number;
  dashTimer: number;
  dashCooldown: number;
  lastDirX: number;
  lastDirY: number;
}

export interface ArenaStar {
  id: number;
  x: number;
  y: number;
  value: number;
  radius: number;
}

export interface ArenaState {
  phase: "playing" | "finished";
  timeLeft: number;
  winnerName: string | null;
  players: Record<string, ArenaPlayer>;
  stars: ArenaStar[];
  nextStarId: number;
  inputs: Record<string, { moveX: number; moveY: number; primary: boolean }>;
}

export function createSimulation() {
  function spawnStar(state: ArenaState, ctx: any): ArenaStar {
    const w = ctx.worldSize.width;
    const h = ctx.worldSize.height;
    const golden = ctx.rng.next() < 0.2;
    return {
      id: state.nextStarId++,
      x: ctx.rng.range(60, w - 60),
      y: ctx.rng.range(72, h - 60),
      value: golden ? 3 : 1,
      radius: golden ? 15 : 11,
    };
  }

  return {
    init(ctx: any): ArenaState {
      const roundSeconds = Number(ctx.config.roundSeconds ?? 60);
      const starCount = Number(ctx.config.starCount ?? 7);
      const state: ArenaState = {
        phase: "playing",
        timeLeft: roundSeconds,
        winnerName: null,
        players: {},
        stars: [],
        nextStarId: 1,
        inputs: {},
      };
      for (let i = 0; i < starCount; i += 1) {
        state.stars.push(spawnStar(state, ctx));
      }
      return state;
    },

    onPlayerJoin(state: ArenaState, player: { id: string; name: string; color: string }, ctx: any) {
      const idx = Object.keys(state.players).length;
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;
      const spawns = [
        { x: w * 0.22, y: h * 0.3 },
        { x: w * 0.78, y: h * 0.7 },
        { x: w * 0.78, y: h * 0.3 },
        { x: w * 0.22, y: h * 0.7 },
      ];
      const sp = spawns[idx % spawns.length]!;
      state.players[player.id] = {
        id: player.id,
        name: player.name,
        color: player.color || "#38bdf8",
        x: sp.x,
        y: sp.y,
        vx: 0,
        vy: 0,
        kbX: 0,
        kbY: 0,
        radius: 20,
        score: 0,
        dashTimer: 0,
        dashCooldown: 0,
        lastDirX: 1,
        lastDirY: 0,
      };
    },

    onPlayerLeave(state: ArenaState, playerId: string) {
      delete state.players[playerId];
      delete state.inputs[playerId];
    },

    onInput(state: ArenaState, playerId: string, input: any) {
      state.inputs[playerId] = {
        moveX: clamp(Number(input.moveX || 0), -1, 1),
        moveY: clamp(Number(input.moveY || 0), -1, 1),
        primary: Boolean(input.primary),
      };
    },

    onTick(state: ArenaState, ctx: any) {
      const dt = ctx.dt;
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;
      const targetStars = Math.max(2, Number(ctx.config.starCount ?? 7));

      if (state.phase === "finished") {
        return;
      }

      state.timeLeft = Math.max(0, state.timeLeft - dt);
      if (state.timeLeft <= 0) {
        state.phase = "finished";
        const ranked = Object.values(state.players).sort((a, b) => b.score - a.score);
        state.winnerName = ranked[0]?.name ?? "平局";
        ctx.emit("sfx", { preset: "win" });
        return;
      }

      const moveSpeed = Number(ctx.config.moveSpeed ?? 260);
      const dashForce = Number(ctx.config.dashForce ?? 2.5);
      const knockback = Number(ctx.config.knockback ?? 340);

      const list = Object.values(state.players);
      for (const p of list) {
        const inp = state.inputs[p.id] ?? { moveX: 0, moveY: 0, primary: false };
        p.dashTimer = Math.max(0, p.dashTimer - dt);
        p.dashCooldown = Math.max(0, p.dashCooldown - dt);

        if (Math.hypot(inp.moveX, inp.moveY) > 0.1) {
          p.lastDirX = inp.moveX;
          p.lastDirY = inp.moveY;
        }

        if (inp.primary && p.dashCooldown <= 0) {
          p.dashTimer = 0.22;
          p.dashCooldown = 1.2;
          ctx.emit("sfx", { preset: "dash", playerId: p.id });
        }

        const dirX = p.dashTimer > 0 ? p.lastDirX : inp.moveX;
        const dirY = p.dashTimer > 0 ? p.lastDirY : inp.moveY;
        const speed = p.dashTimer > 0 ? moveSpeed * dashForce : moveSpeed;

        p.kbX *= Math.pow(0.06, dt);
        p.kbY *= Math.pow(0.06, dt);
        p.vx = dirX * speed + p.kbX;
        p.vy = dirY * speed + p.kbY;

        p.x = clamp(p.x + p.vx * dt, p.radius + 14, w - p.radius - 14);
        p.y = clamp(p.y + p.vy * dt, p.radius + 54, h - p.radius - 14);
      }

      // Player vs Player dash collisions
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!;
          const b = list[j]!;
          if (circleOverlap(a.x, a.y, a.radius, b.x, b.y, b.radius)) {
            const dist = Math.max(1, distance(a.x, a.y, b.x, b.y));
            const nx = (b.x - a.x) / dist;
            const ny = (b.y - a.y) / dist;
            const overlap = a.radius + b.radius - dist;
            a.x -= nx * overlap * 0.5;
            a.y -= ny * overlap * 0.5;
            b.x += nx * overlap * 0.5;
            b.y += ny * overlap * 0.5;

            if (a.dashTimer > 0 && b.dashTimer <= 0) {
              b.kbX += nx * knockback;
              b.kbY += ny * knockback;
              if (b.score > 0) {
                b.score -= 1;
                a.score += 1;
              }
              ctx.emit("sfx", { preset: "hit" });
            } else if (b.dashTimer > 0 && a.dashTimer <= 0) {
              a.kbX -= nx * knockback;
              a.kbY -= ny * knockback;
              if (a.score > 0) {
                a.score -= 1;
                b.score += 1;
              }
              ctx.emit("sfx", { preset: "hit" });
            }
          }
        }
      }

      // Collect stars
      for (const p of list) {
        for (let i = state.stars.length - 1; i >= 0; i -= 1) {
          const st = state.stars[i]!;
          if (circleOverlap(p.x, p.y, p.radius + 3, st.x, st.y, st.radius)) {
            p.score += st.value;
            state.stars.splice(i, 1);
            ctx.emit("sfx", { preset: "coin", playerId: p.id });
          }
        }
      }

      while (state.stars.length < targetStars) {
        state.stars.push(spawnStar(state, ctx));
      }
    },

    getPublicState(state: ArenaState) {
      return {
        phase: state.phase,
        timeLeft: Number(state.timeLeft.toFixed(1)),
        winnerName: state.winnerName,
        players: state.players,
        stars: state.stars,
      };
    },
  };
}
`;

const rendererCode = `import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { lerpPos } from "@aa-game/game-sdk";

function parseHexColor(hex: string): number {
  const clean = (hex || "#38bdf8").replace("#", "");
  const n = Number.parseInt(clean, 16);
  return Number.isFinite(n) ? n : 0x38bdf8;
}

export function createRenderer() {
  let bgGfx: Graphics;
  let entityLayer: Container;
  let blueStarTex: Texture;
  let goldStarTex: Texture;
  let playerDiscTex: Texture;
  let dashHaloTex: Texture;
  let selfRingTex: Texture;
  let eyeDotTex: Texture;

  const starPool: Sprite[] = [];
  const playerViews = new Map<string, { root: Container; halo: Sprite; body: Sprite; ring: Sprite; eye: Sprite }>();

  let hudEl: HTMLDivElement;
  let boardEl: HTMLDivElement;
  let timerEl: HTMLDivElement;
  let finishOverlay: HTMLDivElement;
  let winnerEl: HTMLDivElement;

  let lastBoardKey = "";
  let lastTimerSec = -1;
  let lastPhase = "";

  function bakeTex(app: any, draw: (g: Graphics) => void): Texture {
    const g = new Graphics();
    draw(g);
    const tex = app.renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    return tex;
  }

  return {
    init(ctx: any) {
      const w = ctx.worldSize.width;
      const h = ctx.worldSize.height;

      // 1. Static arena floor & grid cached ONCE into a GPU texture
      bgGfx = new Graphics();
      bgGfx.rect(0, 0, w, h).fill({ color: 0x0b1120 });
      bgGfx.roundRect(12, 52, w - 24, h - 64, 18).stroke({ color: 0x334155, width: 3 });
      for (let x = 60; x < w - 20; x += 60) {
        bgGfx.moveTo(x, 54).lineTo(x, h - 14).stroke({ color: 0x1e293b, width: 1, alpha: 0.45 });
      }
      for (let y = 100; y < h - 20; y += 60) {
        bgGfx.moveTo(14, y).lineTo(w - 14, y).stroke({ color: 0x1e293b, width: 1, alpha: 0.45 });
      }
      if (typeof bgGfx.cacheAsTexture === "function") {
        bgGfx.cacheAsTexture(true);
      }
      ctx.worldLayer.addChild(bgGfx);

      // 2. Pre-bake reusable textures once
      blueStarTex = bakeTex(ctx.app, (g) => {
        g.circle(18, 18, 16.5).fill({ color: 0x38bdf8, alpha: 0.24 });
        g.circle(18, 18, 11).fill({ color: 0x7dd3fc });
      });
      goldStarTex = bakeTex(ctx.app, (g) => {
        g.circle(24, 24, 22.5).fill({ color: 0xf59e0b, alpha: 0.24 });
        g.circle(24, 24, 15).fill({ color: 0xfde047 });
      });
      playerDiscTex = bakeTex(ctx.app, (g) => {
        g.circle(22, 22, 20).fill({ color: 0xffffff });
      });
      dashHaloTex = bakeTex(ctx.app, (g) => {
        g.circle(36, 36, 34).fill({ color: 0xffffff, alpha: 0.35 });
      });
      selfRingTex = bakeTex(ctx.app, (g) => {
        g.circle(28, 28, 25).stroke({ color: 0xffffff, width: 2.5 });
      });
      eyeDotTex = bakeTex(ctx.app, (g) => {
        g.circle(6, 6, 5).fill({ color: 0x0f172a });
      });

      entityLayer = new Container();
      ctx.worldLayer.addChild(entityLayer);

      // 3. Build HUD DOM skeleton ONCE (dirty-checked updates)
      hudEl = document.createElement("div");
      hudEl.style.cssText =
        "position:absolute;top:max(10px,env(safe-area-inset-top));left:12px;right:12px;display:flex;justify-content:space-between;align-items:flex-start;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;color:#f8fafc;z-index:15;";

      boardEl = document.createElement("div");
      boardEl.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";

      timerEl = document.createElement("div");
      timerEl.style.cssText =
        "background:rgba(15,23,42,0.82);border:1px solid rgba(52,211,153,0.45);padding:5px 12px;border-radius:10px;font-weight:800;font-size:14px;color:#34d399;";

      finishOverlay = document.createElement("div");
      finishOverlay.style.cssText =
        "position:fixed;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;";
      const finCard = document.createElement("div");
      finCard.style.cssText =
        "background:rgba(11,17,32,0.92);border:1px solid rgba(52,211,153,0.6);padding:22px 32px;border-radius:16px;text-align:center;";
      const finTitle = document.createElement("div");
      finTitle.style.cssText = "font-size:24px;font-weight:800;color:#f8fafc;";
      finTitle.textContent = "对局结束";
      winnerEl = document.createElement("div");
      winnerEl.style.cssText = "margin-top:8px;font-size:18px;color:#fde047;";
      const finHint = document.createElement("div");
      finHint.style.cssText = "margin-top:8px;font-size:13px;color:#94a3b8;";
      finHint.textContent = "点击上方“重开”开启新一轮竞技";
      finCard.append(finTitle, winnerEl, finHint);
      finishOverlay.appendChild(finCard);

      hudEl.append(boardEl, timerEl, finishOverlay);
      ctx.hudDomRoot.appendChild(hudEl);
    },

    onEvent(ev: any, ctx: any) {
      if (ev.type === "sfx" && ev.payload?.preset) {
        ctx.audio.play(ev.payload.preset);
      }
    },

    render(state: any, prevState: any, alpha: number, ctx: any) {
      // Pooled stars
      const stars = state.stars ?? [];
      for (let i = 0; i < stars.length; i += 1) {
        const st = stars[i]!;
        const tex = st.value > 1 ? goldStarTex : blueStarTex;
        let sp = starPool[i];
        if (!sp) {
          sp = new Sprite(tex);
          sp.anchor.set(0.5);
          entityLayer.addChild(sp);
          starPool[i] = sp;
        }
        if (sp.texture !== tex) sp.texture = tex;
        sp.visible = true;
        sp.position.set(st.x, st.y);
      }
      for (let i = stars.length; i < starPool.length; i += 1) {
        starPool[i]!.visible = false;
      }

      // Pooled player containers
      const players = Object.values(state.players ?? {}) as any[];
      const seen = new Set<string>();
      for (const p of players) {
        seen.add(p.id);
        let view = playerViews.get(p.id);
        if (!view) {
          const root = new Container();
          const halo = new Sprite(dashHaloTex);
          halo.anchor.set(0.5);
          const body = new Sprite(playerDiscTex);
          body.anchor.set(0.5);
          const ring = new Sprite(selfRingTex);
          ring.anchor.set(0.5);
          const eye = new Sprite(eyeDotTex);
          eye.anchor.set(0.5);
          root.addChild(halo, body, ring, eye);
          entityLayer.addChild(root);
          view = { root, halo, body, ring, eye };
          playerViews.set(p.id, view);
        }
        const prevP = prevState?.players?.[p.id];
        const pos = lerpPos(prevP, p, alpha);
        const col = parseHexColor(p.color);
        view.root.visible = true;
        view.root.position.set(pos.x, pos.y);
        view.body.tint = col;
        view.halo.tint = col;
        view.halo.visible = p.dashTimer > 0;
        view.ring.visible = p.id === ctx.localPlayerId;
        view.eye.position.set((p.lastDirX || 0) * 8, (p.lastDirY || 0) * 8);
      }
      for (const [id, view] of playerViews.entries()) {
        if (!seen.has(id)) view.root.visible = false;
      }

      // Dirty-checked HUD updates (only mutate DOM when scores/timer/phase change)
      const ranked = [...players].sort((a, b) => b.score - a.score);
      const boardKey = ranked.map((p) => \`\${p.id}:\${p.name}:\${p.score}:\${p.color}\`).join("|") + "|" + ctx.localPlayerId;
      if (boardKey !== lastBoardKey) {
        lastBoardKey = boardKey;
        boardEl.innerHTML = ranked
          .map(
            (p) =>
              \`<span style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;background:rgba(15,23,42,0.78);border:1px solid \${p.color};font-size:12px;font-weight:700;">
                <i style="width:8px;height:8px;border-radius:50%;background:\${p.color};display:inline-block;"></i>
                \${p.name}\${p.id === ctx.localPlayerId ? " (你)" : ""}: <b style="color:#fde047">\${p.score}</b>
              </span>\`,
          )
          .join("");
      }

      const sec = Math.ceil(state.timeLeft ?? 0);
      if (sec !== lastTimerSec) {
        lastTimerSec = sec;
        timerEl.textContent = \`⏱ \${sec}s\`;
      }

      const phase = state.phase ?? "playing";
      if (phase !== lastPhase) {
        lastPhase = phase;
        finishOverlay.style.display = phase === "finished" ? "flex" : "none";
        if (phase === "finished") {
          winnerEl.textContent = \`🏆 获胜者：\${state.winnerName ?? "平局"}\`;
        }
      }
    },

    destroy() {
      bgGfx?.destroy();
      entityLayer?.destroy({ children: true });
      blueStarTex?.destroy(true);
      goldStarTex?.destroy(true);
      playerDiscTex?.destroy(true);
      dashHaloTex?.destroy(true);
      selfRingTex?.destroy(true);
      eyeDotTex?.destroy(true);
      hudEl?.remove();
    },
  };
}
`;

export const starDashArenaTemplate: TemplateProject = {
  id: spec.id,
  name: spec.title,
  tagline: "2D 实时多人 · 权威 workerd 房间竞技场（双窗模拟 + 手机扫码同房对战）",
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
