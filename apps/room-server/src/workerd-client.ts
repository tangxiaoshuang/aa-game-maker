import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { GameConfigValues, GameEvent, PlayerInputState, SmokeTestResponse } from "@aa-game/protocol";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

export interface WorkerdRoomTickResult {
  ok: boolean;
  tick?: number;
  state?: unknown;
  events?: GameEvent[];
  error?: string;
  stack?: string;
}

/**
 * Manages the local open-source `workerd` V8 Isolate runtime process
 * and communicates with its supervisor over 127.0.0.1.
 */
export class WorkerdSandboxClient {
  private proc: ChildProcess | null = null;
  private readonly port: number;
  private readonly baseUrl: string;
  private started = false;

  constructor(port = Number(process.env.WORKERD_PORT || 4001)) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private resolveWorkerdBin(): string {
    try {
      const mod = require("workerd") as { default?: string; binaryPath?: string };
      const binPath = mod.binaryPath || mod.default;
      if (typeof binPath === "string" && fs.existsSync(binPath)) {
        return binPath;
      }
    } catch {
      // fall back to bin lookup
    }
    const candidates = [
      path.resolve(appRoot, "node_modules/.bin/workerd"),
      path.resolve(appRoot, "../../node_modules/.bin/workerd"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return "workerd";
  }

  private buildRuntimeCapnp(): string {
    const tmpDir = path.resolve(appRoot, ".workerd-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });

    const supervisorSrc = path.resolve(appRoot, "workerd/supervisor.mjs");
    const supervisorDst = path.resolve(tmpDir, "supervisor.mjs");
    fs.copyFileSync(supervisorSrc, supervisorDst);

    const capnpPath = path.resolve(tmpDir, `config-${this.port}.capnp`);
    const capnp = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "supervisor",
      worker = (
        compatibilityDate = "2025-09-01",
        compatibilityFlags = ["experimental"],
        modules = [
          (name = "supervisor.mjs", esModule = embed "supervisor.mjs")
        ],
        bindings = [
          (name = "LOADER", workerLoader = ())
        ]
      )
    )
  ],
  sockets = [
    (
      name = "http",
      address = "127.0.0.1:${this.port}",
      http = (),
      service = "supervisor"
    )
  ]
);
`;
    fs.writeFileSync(capnpPath, capnp, "utf8");
    return capnpPath;
  }

  async start(): Promise<void> {
    if (this.started && (await this.isHealthy())) return;

    const capnpPath = this.buildRuntimeCapnp();
    const bin = this.resolveWorkerdBin();

    this.proc = spawn(bin, ["serve", "--experimental", "--verbose", capnpPath], {
      cwd: appRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    let earlyExit: string | null = null;
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      if (stderrChunks.length > 30) stderrChunks.shift();
      if (process.env.DEBUG_WORKERD) {
        process.stderr.write(`[workerd] ${text}`);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.started = false;
      this.proc = null;
      earlyExit = `code=${code} signal=${signal}`;
      if (code !== 0 && code !== null) {
        console.error(`[workerd] exited unexpectedly ${earlyExit}\n${stderrChunks.join("")}`);
      }
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (earlyExit) {
        await this.stop();
        throw new Error(`workerd exited early (${earlyExit}).\nStderr:\n${stderrChunks.join("")}`);
      }
      if (await this.isHealthy()) {
        this.started = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    await this.stop();
    throw new Error(
      `Failed to start workerd on ${this.baseUrl} within 10s.\nStderr:\n${stderrChunks.join("")}`,
    );
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.started = false;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return false;
      const data = (await res.json()) as { ok?: boolean };
      return Boolean(data.ok);
    } catch {
      return false;
    }
  }

  private async post<T>(pathname: string, body: unknown, timeoutMs = 4000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await res.json()) as T;
  }

  async initRoom(params: {
    roomId: string;
    version: number;
    simBundle: string;
    worldSize: { width: number; height: number };
    tickRate: number;
    config: GameConfigValues;
    seed?: number;
  }): Promise<WorkerdRoomTickResult> {
    return this.post<WorkerdRoomTickResult>("/room/init", params);
  }

  async joinPlayer(
    roomId: string,
    player: { id: string; name: string; color: string },
  ): Promise<WorkerdRoomTickResult> {
    return this.post<WorkerdRoomTickResult>("/room/join", { roomId, player });
  }

  async leavePlayer(roomId: string, playerId: string): Promise<WorkerdRoomTickResult> {
    return this.post<WorkerdRoomTickResult>("/room/leave", { roomId, playerId });
  }

  async updateConfig(roomId: string, config: GameConfigValues): Promise<WorkerdRoomTickResult> {
    return this.post<WorkerdRoomTickResult>("/room/config", { roomId, config });
  }

  async tickRoom(
    roomId: string,
    inputs: Array<{ playerId: string; input: PlayerInputState }>,
  ): Promise<WorkerdRoomTickResult> {
    return this.post<WorkerdRoomTickResult>("/room/tick", { roomId, inputs }, 1500);
  }

  async destroyRoom(roomId: string): Promise<void> {
    await this.post("/room/destroy", { roomId }).catch(() => {});
  }

  async runSmokeTest(params: {
    simBundle: string;
    spec: { worldSize: { width: number; height: number }; tickRate: number; mode: string; maxPlayers: number };
    config: GameConfigValues;
    ticks?: number;
  }): Promise<SmokeTestResponse> {
    return this.post<SmokeTestResponse>("/smoke", params, 8000);
  }
}
