import * as PIXI from "pixi.js";
import * as GameSDK from "@aa-game/game-sdk";
import type {
  DeviceViewportMode,
  GameConfigValues,
  LoadGamePayload,
  PlayerToWorkbenchMessage,
  RoomPhase,
  RoomPlayerInfo,
  RuntimeLogEntry,
  ServerRoomMessage,
  WorkbenchToPlayerMessage,
} from "@aa-game/protocol";

// Expose runtime libraries so browser-bundled ES modules can import them without CDN fetches.
(globalThis as unknown as Record<string, unknown>).__AA_PIXI__ = PIXI;
(globalThis as unknown as Record<string, unknown>).__AA_SDK__ = GameSDK;

const stageRoot = document.getElementById("stage-root")!;
const hudRoot = document.getElementById("hud-root")!;
const controlsRoot = document.getElementById("controls-root")!;
const lobbyRoot = document.getElementById("lobby-root")!;
const statusBanner = document.getElementById("status-banner")!;

function postToParent(msg: PlayerToWorkbenchMessage): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(msg, "*");
  }
}

class SandboxRuntime {
  private app: PIXI.Application | null = null;
  private worldLayer: PIXI.Container | null = null;
  private hudLayer: PIXI.Container | null = null;
  private audio: GameSDK.ProceduralAudio | null = null;
  private input: GameSDK.UnifiedInputController | null = null;
  private renderer: GameSDK.GameRenderer | null = null;
  private localRunner: GameSDK.HeadlessRunner | null = null;
  private ws: WebSocket | null = null;
  private rafId: number | null = null;
  private inputTimer: number | null = null;
  private metricsTimer: number | null = null;
  private pingTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private blobUrls: string[] = [];

  private payload: LoadGamePayload | null = null;
  private deviceMode: DeviceViewportMode = "pc";
  private paused = false;

  private currState: unknown = null;
  private prevState: unknown = null;
  private lastSnapTime = 0;
  private tickIntervalMs = 50;
  private tickCount = 0;
  private frameCounter = 0;
  private lastFpsSample = performance.now();
  private currentFps = 0;
  private latencyMs = 0;

  private localPlayerId = "local";
  private hostPlayerId = "";
  private roomId = "";
  private roomCode = "";
  private roomPhase: RoomPhase = "playing";
  private roomPlayers: RoomPlayerInfo[] = [];
  private runtimeErrors: RuntimeLogEntry[] = [];

  constructor() {
    window.addEventListener("error", (ev) => {
      this.log("error", ev.message || "Uncaught error", ev.error?.stack);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const reason = ev.reason;
      this.log(
        "error",
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined,
      );
    });
  }

  log(level: RuntimeLogEntry["level"], message: string, stack?: string): void {
    const entry: RuntimeLogEntry = { level, message, stack, timestamp: Date.now() };
    if (level === "error") {
      this.runtimeErrors.push(entry);
      if (this.runtimeErrors.length > 30) this.runtimeErrors.shift();
    }
    postToParent({ channel: "aa-game-sandbox", type: "RUNTIME_LOG", entry });
  }

  private isTouchOrMobile(): boolean {
    if (this.deviceMode !== "pc") return true;
    return window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window;
  }

  private async importEsmString<T>(code: string): Promise<T> {
    const blob = new Blob([code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    this.blobUrls.push(url);
    return (await import(/* @vite-ignore */ url)) as T;
  }

  async cleanup(): Promise<void> {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.inputTimer !== null) clearInterval(this.inputTimer);
    if (this.metricsTimer !== null) clearInterval(this.metricsTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.rafId = null;
    this.inputTimer = null;
    this.metricsTimer = null;
    this.pingTimer = null;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    try {
      this.renderer?.destroy?.();
    } catch {
      // ignore teardown errors from user renderer
    }
    this.renderer = null;
    this.localRunner = null;
    this.input?.destroy();
    this.input = null;
    this.audio?.destroy();
    this.audio = null;

    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }

    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls = [];
    stageRoot.innerHTML = "";
    hudRoot.innerHTML = "";
    controlsRoot.innerHTML = "";
    lobbyRoot.innerHTML = "";
  }

  async load(payload: LoadGamePayload): Promise<void> {
    await this.cleanup();
    this.payload = payload;
    this.deviceMode = payload.deviceMode;
    this.paused = false;
    this.runtimeErrors = [];
    this.currState = null;
    this.prevState = null;
    this.tickCount = 0;
    this.tickIntervalMs = 1000 / Math.max(10, Math.min(60, payload.spec.tickRate || 20));
    statusBanner.style.display = "none";

    try {
      const app = new PIXI.Application();
      await app.init({
        width: window.innerWidth || 640,
        height: window.innerHeight || 480,
        backgroundColor: 0x070b18,
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        preserveDrawingBuffer: true,
      });
      stageRoot.appendChild(app.canvas);
      this.app = app;

      const worldLayer = new PIXI.Container();
      const hudLayer = new PIXI.Container();
      app.stage.addChild(worldLayer);
      app.stage.addChild(hudLayer);
      this.worldLayer = worldLayer;
      this.hudLayer = hudLayer;

      this.fitWorldToViewport();
      this.resizeObserver = new ResizeObserver(() => this.fitWorldToViewport());
      this.resizeObserver.observe(stageRoot);

      this.audio = new GameSDK.ProceduralAudio();
      this.mountInput();

      // Load Renderer bundle
      const clientMod = await this.importEsmString<{
        createRenderer?: () => GameSDK.GameRenderer;
        default?: () => GameSDK.GameRenderer;
      }>(payload.clientBundle);
      const createRenderer = clientMod.createRenderer ?? clientMod.default;
      if (typeof createRenderer !== "function") {
        throw new Error("renderer.ts must export createRenderer()");
      }
      this.renderer = createRenderer();
      await this.renderer.init(this.makeRendererContext());

      if (payload.spec.mode === "multiplayer" && payload.roomWsUrl) {
        this.connectMultiplayer(payload);
      } else {
        await this.startSingleplayer(payload);
      }

      this.startRenderLoop();
      this.startMetricsLoop();

      postToParent({
        channel: "aa-game-sandbox",
        type: "GAME_LOADED",
        title: payload.spec.title,
        mode: payload.spec.mode,
      });
      this.log("info", `Loaded "${payload.spec.title}" (${payload.spec.mode})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.log("error", msg, stack);
      statusBanner.style.display = "flex";
      statusBanner.innerHTML = `<div style="color:#fb7185;font-weight:700;">运行加载失败</div><pre style="max-width:90%;overflow:auto;font-size:12px;color:#fda4af;">${msg}</pre>`;
    }
  }

  private makeRendererContext(): GameSDK.RendererContext {
    return {
      app: this.app!,
      worldLayer: this.worldLayer!,
      hudLayer: this.hudLayer!,
      hudDomRoot: hudRoot,
      worldSize: this.payload!.spec.worldSize,
      localPlayerId: this.localPlayerId,
      audio: this.audio!,
      assets: this.payload!.assets,
      config: this.payload!.configValues,
      isMobile: this.isTouchOrMobile(),
    };
  }

  private mountInput(): void {
    if (!this.payload) return;
    this.input?.destroy();
    this.input = new GameSDK.UnifiedInputController({
      controlsRoot,
      showVirtualControls: this.isTouchOrMobile(),
      joystick: this.payload.spec.controls.joystick,
      buttons: this.payload.spec.controls.buttons,
    });
  }

  private fitWorldToViewport(): void {
    if (!this.app || !this.worldLayer || !this.payload) return;
    const vw = Math.max(100, stageRoot.clientWidth || window.innerWidth);
    const vh = Math.max(100, stageRoot.clientHeight || window.innerHeight);
    this.app.renderer.resize(vw, vh);

    const worldW = this.payload.spec.worldSize.width;
    const worldH = this.payload.spec.worldSize.height;
    const scale = Math.min(vw / worldW, vh / worldH);
    this.worldLayer.scale.set(scale);
    this.worldLayer.position.set((vw - worldW * scale) / 2, (vh - worldH * scale) / 2);
  }

  private async startSingleplayer(payload: LoadGamePayload): Promise<void> {
    const simMod = await this.importEsmString<{
      createSimulation?: () => GameSDK.GameSimulation;
      default?: () => GameSDK.GameSimulation;
    }>(payload.simBundle);
    const createSimulation = simMod.createSimulation ?? simMod.default;
    if (typeof createSimulation !== "function") {
      throw new Error("simulation.ts must export createSimulation()");
    }
    const sim = createSimulation();
    this.localPlayerId = "local";
    this.roomPhase = "playing";
    this.localRunner = new GameSDK.HeadlessRunner(sim, {
      worldSize: payload.spec.worldSize,
      tickRate: payload.spec.tickRate,
      config: payload.configValues,
      seed: Date.now() & 0x7fffffff,
    });
    this.localRunner.addPlayer({ id: "local", name: "Player", color: "#38bdf8" });
    this.currState = this.localRunner.getSnapshot();
    this.prevState = this.currState;
    this.lastSnapTime = performance.now();

    this.inputTimer = window.setInterval(() => {
      if (this.paused || !this.localRunner || !this.input) return;
      this.localRunner.applyInput("local", this.input.sample());
      const res = this.localRunner.step();
      this.prevState = this.currState;
      this.currState = structuredClone(res.state);
      this.tickCount = res.tick;
      this.lastSnapTime = performance.now();
      for (const ev of res.events) {
        this.renderer?.onEvent?.(ev, this.makeRendererContext());
      }
    }, this.tickIntervalMs);
  }

  private connectMultiplayer(payload: LoadGamePayload): void {
    const wsUrl = payload.roomWsUrl!;
    const playerName = payload.playerName || `Player-${Math.floor(Math.random() * 90 + 10)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", playerName }));
      this.log("info", `Connected to workerd room (${wsUrl})`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerRoomMessage;
        if (msg.type === "welcome") {
          this.localPlayerId = msg.playerId;
          this.hostPlayerId = msg.hostPlayerId;
          this.roomId = msg.roomId;
          this.roomCode = msg.roomCode;
          this.roomPlayers = msg.players;
          this.roomPhase = msg.phase;
          this.tickIntervalMs = 1000 / Math.max(10, msg.tickRate);
          if (msg.snapshot) {
            this.prevState = msg.snapshot;
            this.currState = msg.snapshot;
            this.lastSnapTime = performance.now();
          }
          this.renderLobbyOverlay();
          this.startNetworkLoops();
        } else if (msg.type === "room_update") {
          this.hostPlayerId = msg.hostPlayerId;
          this.roomPlayers = msg.players;
          this.roomPhase = msg.phase;
          if (this.payload) {
            this.payload.configValues = { ...msg.config };
          }
          this.renderLobbyOverlay();
        } else if (msg.type === "snapshot") {
          this.prevState = this.currState ?? msg.state;
          this.currState = msg.state;
          this.tickCount = msg.tick;
          this.lastSnapTime = performance.now();
          for (const ev of msg.events) {
            this.renderer?.onEvent?.(ev, this.makeRendererContext());
          }
        } else if (msg.type === "pong") {
          this.latencyMs = Math.max(0, Math.round(performance.now() - msg.t));
        } else if (msg.type === "error") {
          this.log("error", `[Room ${msg.code}] ${msg.message}`, msg.stack);
        }
      } catch (err) {
        this.log("error", `Invalid room message: ${String(err)}`);
      }
    };

    ws.onerror = () => {
      this.log("error", "WebSocket connection to room-server failed");
    };

    ws.onclose = () => {
      this.log("warn", "Disconnected from authoritative room");
    };
  }

  private startNetworkLoops(): void {
    if (this.inputTimer !== null) clearInterval(this.inputTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);

    this.inputTimer = window.setInterval(() => {
      if (this.paused || this.roomPhase !== "playing") return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.input) return;
      this.ws.send(JSON.stringify({ type: "input", input: this.input.sample() }));
    }, this.tickIntervalMs);

    this.pingTimer = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
      }
    }, 2000);
  }

  private renderLobbyOverlay(): void {
    lobbyRoot.innerHTML = "";
    if (this.roomPhase === "playing") return;

    const isHost = this.localPlayerId === this.hostPlayerId;
    const me = this.roomPlayers.find((p) => p.id === this.localPlayerId);
    const card = document.createElement("div");
    card.className = "lobby-card";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div>
          <div style="font-size:17px;font-weight:800;color:#f8fafc;">${this.payload?.spec.title ?? "联机房间"}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px;">workerd V8 权威联机大厅</div>
        </div>
        <div style="background:rgba(56,189,248,0.18);border:1px solid rgba(56,189,248,0.5);padding:4px 10px;border-radius:8px;font-family:monospace;font-size:15px;font-weight:800;color:#38bdf8;">
          ${this.roomCode}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        ${this.roomPlayers
          .map(
            (p) => `
          <div style="display:flex;justify-content:space-between;align-items:center;background:rgba(30,41,59,0.75);padding:8px 10px;border-radius:10px;font-size:13px;">
            <span style="display:flex;align-items:center;gap:8px;">
              <i style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block;"></i>
              <b>${p.name}</b>${p.id === this.localPlayerId ? " (你)" : ""}${p.id === this.hostPlayerId ? " 👑" : ""}
            </span>
            <span style="color:${p.ready ? "#34d399" : "#94a3b8"};font-weight:700;">${p.ready ? "已准备" : "等待中"}</span>
          </div>`,
          )
          .join("")}
      </div>
      <div style="display:flex;gap:10px;">
        <button id="btn-ready" class="lobby-btn" style="flex:1;background:#334155;color:#f8fafc;">
          ${me?.ready ? "取消准备" : "准备"}
        </button>
        ${
          isHost
            ? `<button id="btn-start" class="lobby-btn" style="flex:1;background:#34d399;color:#0f172a;">开始对局</button>`
            : ""
        }
      </div>
    `;
    lobbyRoot.appendChild(card);

    card.querySelector("#btn-ready")?.addEventListener("click", () => {
      this.ws?.send(JSON.stringify({ type: "ready", ready: !me?.ready }));
    });
    card.querySelector("#btn-start")?.addEventListener("click", () => {
      this.ws?.send(JSON.stringify({ type: "start" }));
    });
  }

  private startRenderLoop(): void {
    const loop = () => {
      this.rafId = requestAnimationFrame(loop);
      this.frameCounter += 1;
      const now = performance.now();
      if (now - this.lastFpsSample >= 500) {
        this.currentFps = Math.round((this.frameCounter * 1000) / (now - this.lastFpsSample));
        this.frameCounter = 0;
        this.lastFpsSample = now;
      }

      if (this.currState && this.renderer && this.app) {
        const alpha = Math.min(1, Math.max(0, (now - this.lastSnapTime) / this.tickIntervalMs));
        try {
          this.renderer.render(this.currState, this.prevState, alpha, this.makeRendererContext());
        } catch (err) {
          this.log(
            "error",
            err instanceof Error ? err.message : String(err),
            err instanceof Error ? err.stack : undefined,
          );
          this.paused = true;
        }
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private startMetricsLoop(): void {
    this.metricsTimer = window.setInterval(() => {
      postToParent({
        channel: "aa-game-sandbox",
        type: "METRICS",
        metrics: {
          fps: this.currentFps,
          tick: this.tickCount,
          roomId: this.roomId || undefined,
          roomCode: this.roomCode || undefined,
          playersCount: this.roomPlayers.length || undefined,
          latencyMs: this.roomId ? this.latencyMs : undefined,
          phase: this.roomPhase,
        },
      });
    }, 600);
  }

  updateConfig(configValues: GameConfigValues): void {
    if (!this.payload) return;
    this.payload.configValues = { ...this.payload.configValues, ...configValues };
    this.localRunner?.updateConfig(this.payload.configValues);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "update_config", config: this.payload.configValues }));
    }
  }

  setDeviceMode(mode: DeviceViewportMode): void {
    this.deviceMode = mode;
    this.mountInput();
    this.fitWorldToViewport();
  }

  async restart(): Promise<void> {
    if (!this.payload) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "restart" }));
    } else {
      await this.load(this.payload);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  runProbe(): void {
    const t0 = performance.now();
    let blankCanvas = true;
    let nonZeroPixelRatio = 0;

    try {
      if (this.app?.canvas) {
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 48;
        sampleCanvas.height = 48;
        const ctx2d = sampleCanvas.getContext("2d");
        if (ctx2d) {
          ctx2d.drawImage(this.app.canvas, 0, 0, 48, 48);
          const data = ctx2d.getImageData(0, 0, 48, 48).data;
          let varied = 0;
          const baseR = data[0] ?? 0;
          const baseG = data[1] ?? 0;
          const baseB = data[2] ?? 0;
          const totalPixels = 48 * 48;
          for (let i = 0; i < data.length; i += 4) {
            const diff =
              Math.abs((data[i] ?? 0) - baseR) +
              Math.abs((data[i + 1] ?? 0) - baseG) +
              Math.abs((data[i + 2] ?? 0) - baseB);
            if (diff > 18) varied += 1;
          }
          nonZeroPixelRatio = Number((varied / totalPixels).toFixed(4));
          blankCanvas = nonZeroPixelRatio < 0.01;
        }
      }
    } catch (err) {
      this.log("warn", `Canvas probe fallback: ${String(err)}`);
    }

    const ok = this.runtimeErrors.length === 0 && !blankCanvas;
    postToParent({
      channel: "aa-game-sandbox",
      type: "PROBE_RESULT",
      result: {
        ok,
        blankCanvas,
        nonZeroPixelRatio,
        errors: [...this.runtimeErrors],
        durationMs: Number((performance.now() - t0).toFixed(2)),
      },
    });
  }
}

const runtime = new SandboxRuntime();

window.addEventListener("message", (event) => {
  const data = event.data as WorkbenchToPlayerMessage | undefined;
  if (!data || data.channel !== "aa-game-sandbox") return;
  if (data.type === "LOAD_GAME") {
    void runtime.load(data.payload);
  } else if (data.type === "UPDATE_CONFIG") {
    runtime.updateConfig(data.configValues);
  } else if (data.type === "SET_DEVICE_MODE") {
    runtime.setDeviceMode(data.deviceMode);
  } else if (data.type === "RESTART_GAME") {
    void runtime.restart();
  } else if (data.type === "SET_PAUSED") {
    runtime.setPaused(data.paused);
  } else if (data.type === "RUN_PROBE") {
    runtime.runProbe();
  }
});

// Direct mobile QR code / standalone room OR published release mode:
//   1. ?room=<CODE>&api=http://<IP>:4000
//   2. ?release=<SLUG>&api=http://<IP>:4002&roomApi=http://<IP>:4000
async function bootFromQueryParams(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const roomKey = params.get("room");
  const releaseSlug = params.get("release");

  if (!roomKey && !releaseSlug) {
    postToParent({ channel: "aa-game-sandbox", type: "PLAYER_READY" });
    return;
  }

  if (releaseSlug) {
    const apiBase =
      params.get("api") || `${window.location.protocol}//${window.location.hostname}:4002`;
    const roomApiBase =
      params.get("roomApi") || `${window.location.protocol}//${window.location.hostname}:4000`;
    const roomWsBase = roomApiBase.replace(/^http/, "ws");

    statusBanner.style.display = "flex";
    statusBanner.textContent = `正在加载已发布游戏 ${releaseSlug}...`;

    try {
      const res = await fetch(`${apiBase}/api/releases/${encodeURIComponent(releaseSlug)}`);
      if (!res.ok) throw new Error(`作品 ${releaseSlug} 不存在 (${res.status})`);
      const data = await res.json();
      const isPortrait = window.innerHeight >= window.innerWidth;
      const autoDevice: DeviceViewportMode =
        window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window
          ? isPortrait
            ? "mobile-portrait"
            : "mobile-landscape"
          : "pc";

      if (data.spec?.mode === "multiplayer") {
        // Show clean platform HTML launcher to create or join a live workerd multiplayer room
        statusBanner.style.display = "none";
        lobbyRoot.innerHTML = "";
        const card = document.createElement("div");
        card.className = "lobby-card";
        card.innerHTML = `
          <div style="font-size:18px;font-weight:800;color:#f8fafc;margin-bottom:4px;">${data.release.title}</div>
          <div style="font-size:12px;color:#94a3b8;margin-bottom:14px;">2D 实时多人 · workerd V8 权威联机房</div>
          <input id="mp-name" value="玩家-${Math.floor(Math.random() * 90 + 10)}" placeholder="你的昵称" style="width:100%;box-sizing:border-box;background:#070b14;border:1px solid #334155;border-radius:8px;padding:8px 10px;color:#f8fafc;margin-bottom:10px;font-size:13px;" />
          <button id="mp-create" class="lobby-btn" style="width:100%;background:#10b981;color:#052e16;margin-bottom:10px;">🚀 创建新联机房间</button>
          <div style="display:flex;gap:6px;">
            <input id="mp-code" placeholder="输入 6 位房间码加入" style="flex:1;background:#070b14;border:1px solid #334155;border-radius:8px;padding:8px 10px;color:#f8fafc;font-size:13px;text-transform:uppercase;font-family:monospace;" />
            <button id="mp-join" class="lobby-btn" style="background:#0284c7;color:#fff;">加入</button>
          </div>
          <div id="mp-err" style="color:#fb7185;font-size:12px;margin-top:8px;"></div>
        `;
        lobbyRoot.appendChild(card);

        card.querySelector("#mp-create")?.addEventListener("click", async () => {
          const nameInput = (card.querySelector("#mp-name") as HTMLInputElement).value.trim() || "房主";
          try {
            const createRes = await fetch(`${roomApiBase}/api/rooms`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                gameId: data.spec.id,
                title: data.release.title,
                simBundle: data.simBundle,
                clientBundle: data.clientBundle,
                spec: data.spec,
                configSchema: data.configSchema,
                configValues: data.configValues,
                assets: data.assets,
                maxPlayers: data.spec.maxPlayers,
                tickRate: data.spec.tickRate,
                autoStart: false,
              }),
            });
            if (!createRes.ok) throw new Error(await createRes.text());
            const created = await createRes.json();
            await runtime.load({
              spec: data.spec,
              configSchema: data.configSchema ?? [],
              configValues: data.configValues ?? {},
              assets: data.assets ?? { version: 1, assets: [] },
              clientBundle: data.clientBundle,
              simBundle: data.simBundle,
              deviceMode: autoDevice,
              roomWsUrl: `${roomWsBase}${created.wsPath}`,
              roomId: created.roomId,
              roomCode: created.roomCode,
              playerName: nameInput,
            });
          } catch (err) {
            (card.querySelector("#mp-err") as HTMLElement).textContent = `建房失败: ${String(err)}`;
          }
        });

        card.querySelector("#mp-join")?.addEventListener("click", async () => {
          const code = (card.querySelector("#mp-code") as HTMLInputElement).value.trim().toUpperCase();
          const nameInput = (card.querySelector("#mp-name") as HTMLInputElement).value.trim() || "玩家";
          if (!code) return;
          try {
            const r = await fetch(`${roomApiBase}/api/rooms/${encodeURIComponent(code)}`);
            if (!r.ok) throw new Error(`房间 ${code} 不存在`);
            const roomData = await r.json();
            await runtime.load({
              spec: roomData.spec,
              configSchema: roomData.configSchema ?? [],
              configValues: roomData.configValues ?? {},
              assets: roomData.assets ?? { version: 1, assets: [] },
              clientBundle: roomData.clientBundle,
              simBundle: roomData.simBundle,
              deviceMode: autoDevice,
              roomWsUrl: `${roomWsBase}${roomData.wsPath}`,
              roomId: roomData.roomId,
              roomCode: roomData.roomCode,
              playerName: nameInput,
            });
          } catch (err) {
            (card.querySelector("#mp-err") as HTMLElement).textContent = String(err);
          }
        });
        return;
      }

      // Singleplayer published release: load & play immediately!
      await runtime.load({
        spec: data.spec,
        configSchema: data.configSchema ?? [],
        configValues: data.configValues ?? {},
        assets: data.assets ?? { version: 1, assets: [] },
        clientBundle: data.clientBundle,
        simBundle: data.simBundle,
        deviceMode: autoDevice,
      });
    } catch (err) {
      statusBanner.style.display = "flex";
      statusBanner.innerHTML = `<div style="color:#fb7185;font-weight:700;">加载作品失败</div><div style="font-size:13px;">${String(err)}</div>`;
    }
    return;
  }

  const apiBase =
    params.get("api") || `${window.location.protocol}//${window.location.hostname}:4000`;
  const wsBase = apiBase.replace(/^http/, "ws");
  const playerName = params.get("name") || `手机玩家-${Math.floor(Math.random() * 90 + 10)}`;

  statusBanner.style.display = "flex";
  statusBanner.textContent = `正在加入联机房间 ${roomKey}...`;

  try {
    const res = await fetch(`${apiBase}/api/rooms/${encodeURIComponent(roomKey!)}`);
    if (!res.ok) {
      throw new Error(`房间 ${roomKey} 不存在或已过期 (${res.status})`);
    }
    const data = await res.json();
    const isPortrait = window.innerHeight >= window.innerWidth;
    await runtime.load({
      spec: data.spec,
      configSchema: data.configSchema ?? [],
      configValues: data.configValues ?? {},
      assets: data.assets ?? { version: 1, assets: [] },
      clientBundle: data.clientBundle,
      simBundle: data.simBundle,
      deviceMode: isPortrait ? "mobile-portrait" : "mobile-landscape",
      roomWsUrl: `${wsBase}${data.wsPath}`,
      roomId: data.roomId,
      roomCode: data.roomCode,
      playerName,
    });
  } catch (err) {
    statusBanner.style.display = "flex";
    statusBanner.innerHTML = `<div style="color:#fb7185;font-weight:700;">加入房间失败</div><div style="font-size:13px;">${String(err)}</div>`;
  }
}

void bootFromQueryParams();
