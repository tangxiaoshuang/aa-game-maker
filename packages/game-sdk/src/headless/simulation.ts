import type {
  GameConfigValues,
  GameEvent,
  GameSpec,
  PlayerInputState,
  SmokeTestResponse,
  VerifyDiagnostic,
} from "@aa-game/protocol";
import { SeededRng } from "./math.js";

export interface SimPlayerInfo {
  id: string;
  name: string;
  color: string;
}

export interface SimulationContext {
  tick: number;
  elapsedMs: number;
  dt: number;
  rng: SeededRng;
  config: GameConfigValues;
  worldSize: { width: number; height: number };
  emit: (type: string, payload?: Record<string, unknown>) => void;
}

export interface GameSimulation<TState extends Record<string, unknown> = Record<string, unknown>> {
  init(ctx: SimulationContext): TState;
  onPlayerJoin(state: TState, player: SimPlayerInfo, ctx: SimulationContext): void;
  onPlayerLeave(state: TState, playerId: string, ctx: SimulationContext): void;
  onInput(state: TState, playerId: string, input: PlayerInputState, ctx: SimulationContext): void;
  onTick(state: TState, ctx: SimulationContext): void;
  onConfigUpdate?(state: TState, config: GameConfigValues, ctx: SimulationContext): void;
  getPublicState?(state: TState): unknown;
}

export class HeadlessRunner<TState extends Record<string, unknown> = Record<string, unknown>> {
  private readonly sim: GameSimulation<TState>;
  private readonly worldSize: { width: number; height: number };
  private readonly dt: number;
  private rng: SeededRng;
  private config: GameConfigValues;
  private state: TState;
  private tick = 0;
  private elapsedMs = 0;
  private pendingEvents: GameEvent[] = [];

  constructor(
    sim: GameSimulation<TState>,
    options: {
      worldSize: { width: number; height: number };
      tickRate: number;
      config: GameConfigValues;
      seed?: number;
    },
  ) {
    this.sim = sim;
    this.worldSize = options.worldSize;
    this.dt = 1 / Math.max(10, Math.min(60, options.tickRate));
    this.config = { ...options.config };
    this.rng = new SeededRng(options.seed ?? 20261125);
    this.state = this.sim.init(this.makeContext());
  }

  private makeContext(): SimulationContext {
    return {
      tick: this.tick,
      elapsedMs: this.elapsedMs,
      dt: this.dt,
      rng: this.rng,
      config: this.config,
      worldSize: this.worldSize,
      emit: (type, payload) => {
        this.pendingEvents.push({ type, payload });
      },
    };
  }

  addPlayer(player: SimPlayerInfo): void {
    this.sim.onPlayerJoin(this.state, player, this.makeContext());
  }

  removePlayer(playerId: string): void {
    this.sim.onPlayerLeave(this.state, playerId, this.makeContext());
  }

  applyInput(playerId: string, input: PlayerInputState): void {
    this.sim.onInput(this.state, playerId, input, this.makeContext());
  }

  updateConfig(config: GameConfigValues): void {
    this.config = { ...this.config, ...config };
    this.sim.onConfigUpdate?.(this.state, this.config, this.makeContext());
  }

  step(): { tick: number; state: unknown; events: GameEvent[] } {
    this.tick += 1;
    this.elapsedMs += this.dt * 1000;
    this.pendingEvents = [];
    this.sim.onTick(this.state, this.makeContext());
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return {
      tick: this.tick,
      state: this.getSnapshot(),
      events,
    };
  }

  getSnapshot(): unknown {
    return this.sim.getPublicState ? this.sim.getPublicState(this.state) : this.state;
  }

  getTick(): number {
    return this.tick;
  }
}

export function findNonFiniteNumberPath(value: unknown, path = "state"): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : path;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = findNonFiniteNumberPath(value[i], `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const bad = findNonFiniteNumberPath(v, `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

/**
 * L2 Headless Smoke Test: spawns synthetic players, feeds varied movement & action inputs,
 * steps N ticks, and checks for exceptions, NaN/Infinity, slow ticks, and serializability.
 */
export function runHeadlessSmokeTest(
  sim: GameSimulation,
  spec: Pick<GameSpec, "worldSize" | "tickRate" | "mode" | "maxPlayers">,
  config: GameConfigValues,
  ticksToRun = 120,
): SmokeTestResponse {
  const diagnostics: VerifyDiagnostic[] = [];
  const start = performance.now();
  let maxTickMs = 0;
  let stateBytes = 0;
  let ticksExecuted = 0;

  try {
    const runner = new HeadlessRunner(sim, {
      worldSize: spec.worldSize,
      tickRate: spec.tickRate,
      config,
      seed: 42,
    });

    const playerCount = spec.mode === "multiplayer" ? Math.min(2, Math.max(2, spec.maxPlayers)) : 1;
    const colors = ["#38bdf8", "#f472b6", "#34d399", "#fbbf24"];
    for (let i = 0; i < playerCount; i += 1) {
      runner.addPlayer({
        id: `bot_${i + 1}`,
        name: `Bot ${i + 1}`,
        color: colors[i % colors.length]!,
      });
    }

    for (let t = 0; t < ticksToRun; t += 1) {
      for (let i = 0; i < playerCount; i += 1) {
        const angle = (t / 15) + i * Math.PI;
        runner.applyInput(`bot_${i + 1}`, {
          moveX: Number(Math.cos(angle).toFixed(3)),
          moveY: Number(Math.sin(angle).toFixed(3)),
          primary: t % 25 === 0,
          secondary: t % 40 === 0,
          seq: t,
        });
      }

      const tickStart = performance.now();
      const { state } = runner.step();
      const tickMs = performance.now() - tickStart;
      if (tickMs > maxTickMs) maxTickMs = tickMs;
      ticksExecuted += 1;

      if (t === 0 || t === ticksToRun - 1 || t % 30 === 0) {
        const badPath = findNonFiniteNumberPath(state);
        if (badPath) {
          diagnostics.push({
            layer: "L2_SMOKE",
            severity: "error",
            message: `Detected non-finite number (NaN/Infinity) at ${badPath} on tick ${t + 1}`,
          });
          break;
        }
        const serialized = JSON.stringify(state);
        stateBytes = serialized.length;
        if (stateBytes > 64 * 1024) {
          diagnostics.push({
            layer: "L2_SMOKE",
            severity: "warn",
            message: `Snapshot payload is large (${stateBytes} bytes > 64KB); consider trimming state`,
          });
        }
      }
    }

    if (playerCount > 1) {
      runner.removePlayer("bot_2");
      runner.step();
    }

    if (maxTickMs > 12) {
      diagnostics.push({
        layer: "L2_SMOKE",
        severity: "warn",
        message: `Slow simulation tick detected (${maxTickMs.toFixed(2)}ms > 12ms budget)`,
      });
    }
  } catch (err) {
    diagnostics.push({
      layer: "L2_SMOKE",
      severity: "error",
      message: err instanceof Error ? err.message : String(err),
      detail: err instanceof Error ? err.stack : undefined,
    });
  }

  return {
    ok: diagnostics.every((d) => d.severity !== "error"),
    engine: "workerd",
    ticksExecuted,
    durationMs: Number((performance.now() - start).toFixed(2)),
    maxTickMs: Number(maxTickMs.toFixed(3)),
    stateBytes,
    diagnostics,
  };
}
