import type { AssetManifest, ConfigParam, GameConfigValues, GameSpec } from "./game.js";

export type DeviceViewportMode = "pc" | "mobile-portrait" | "mobile-landscape";

export interface LoadGamePayload {
  spec: GameSpec;
  configSchema: ConfigParam[];
  configValues: GameConfigValues;
  assets: AssetManifest;
  clientBundle: string;
  simBundle: string;
  deviceMode: DeviceViewportMode;
  targetFps?: number;
  roomWsUrl?: string;
  roomId?: string;
  roomCode?: string;
  playerName?: string;
  autoStart?: boolean;
}

export type WorkbenchToPlayerMessage =
  | { channel: "aa-game-sandbox"; type: "LOAD_GAME"; payload: LoadGamePayload }
  | { channel: "aa-game-sandbox"; type: "UPDATE_CONFIG"; configValues: GameConfigValues }
  | { channel: "aa-game-sandbox"; type: "SET_DEVICE_MODE"; deviceMode: DeviceViewportMode }
  | { channel: "aa-game-sandbox"; type: "SET_TARGET_FPS"; targetFps: number }
  | { channel: "aa-game-sandbox"; type: "RESTART_GAME" }
  | { channel: "aa-game-sandbox"; type: "SET_PAUSED"; paused: boolean }
  | { channel: "aa-game-sandbox"; type: "RUN_PROBE" };

export interface RuntimeLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  stack?: string;
  timestamp: number;
}

export interface RuntimeMetrics {
  fps: number;
  renderMs?: number;
  targetFps?: number;
  paused?: boolean;
  tick: number;
  roomId?: string;
  roomCode?: string;
  playersCount?: number;
  latencyMs?: number;
  phase?: string;
}

export interface RuntimeProbeResult {
  ok: boolean;
  blankCanvas: boolean;
  nonZeroPixelRatio: number;
  errors: RuntimeLogEntry[];
  durationMs: number;
}

export type PlayerToWorkbenchMessage =
  | { channel: "aa-game-sandbox"; type: "PLAYER_READY" }
  | { channel: "aa-game-sandbox"; type: "GAME_LOADED"; title: string; mode: string }
  | { channel: "aa-game-sandbox"; type: "RUNTIME_LOG"; entry: RuntimeLogEntry }
  | { channel: "aa-game-sandbox"; type: "METRICS"; metrics: RuntimeMetrics }
  | { channel: "aa-game-sandbox"; type: "PROBE_RESULT"; result: RuntimeProbeResult };

export interface VerifyDiagnostic {
  layer: "L1_COMPILE" | "L2_SMOKE" | "L3_RUNTIME";
  severity: "error" | "warn";
  message: string;
  file?: string;
  line?: number;
  detail?: string;
}

export interface SmokeTestResponse {
  ok: boolean;
  engine: "workerd";
  ticksExecuted: number;
  durationMs: number;
  maxTickMs: number;
  stateBytes: number;
  diagnostics: VerifyDiagnostic[];
}

export interface FullVerifyReport {
  ok: boolean;
  l1Compile: { ok: boolean; durationMs: number; diagnostics: VerifyDiagnostic[] };
  l2Smoke: SmokeTestResponse | null;
  l3Runtime: RuntimeProbeResult | null;
}
