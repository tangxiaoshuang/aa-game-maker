import fs from "node:fs";
import path from "node:path";
import {
  AssetEntrySchema,
  AssetManifestSchema,
  GameSpecSchema,
  type FullVerifyReport,
  type GameConfigValues,
  type GameSpec,
  type RuntimeProbeResult,
  type SmokeTestResponse,
} from "@aa-game/protocol";
import { catalogItemToAssetEntry, CC0_ASSET_CATALOG, searchAssetCatalog } from "./catalog.js";
import { compileProjectInNode } from "./bundler-node.js";

export interface WorkspaceAdapter {
  listFiles(): Promise<string[]>;
  readFile(relPath: string): Promise<string | null>;
  writeFile(relPath: string, content: string): Promise<void>;
  getAllFiles(): Promise<Record<string, string>>;
}

function sanitizeRelPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.includes("/../")) {
    throw new Error(`Invalid workspace path: ${relPath}`);
  }
  return normalized;
}

export class MemoryWorkspaceAdapter implements WorkspaceAdapter {
  private readonly files: Record<string, string>;

  constructor(initialFiles: Record<string, string>) {
    this.files = { ...initialFiles };
  }

  async listFiles(): Promise<string[]> {
    return Object.keys(this.files).sort();
  }

  async readFile(relPath: string): Promise<string | null> {
    const clean = sanitizeRelPath(relPath);
    return Object.prototype.hasOwnProperty.call(this.files, clean) ? this.files[clean]! : null;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const clean = sanitizeRelPath(relPath);
    this.files[clean] = content;
  }

  async getAllFiles(): Promise<Record<string, string>> {
    return { ...this.files };
  }
}

export class DiskWorkspaceAdapter implements WorkspaceAdapter {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private resolveSafe(relPath: string): string {
    const clean = sanitizeRelPath(relPath);
    const abs = path.resolve(this.rootDir, clean);
    if (abs !== this.rootDir && !abs.startsWith(this.rootDir + path.sep)) {
      throw new Error(`Path escapes workspace root: ${relPath}`);
    }
    return abs;
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix = "") => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) out.push(rel);
      }
    };
    walk(this.rootDir);
    return out.sort();
  }

  async readFile(relPath: string): Promise<string | null> {
    const abs = this.resolveSafe(relPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, "utf8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolveSafe(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  async getAllFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const rel of await this.listFiles()) {
      const text = await this.readFile(rel);
      if (text !== null) files[rel] = text;
    }
    return files;
  }
}

export interface HarnessToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const HARNESS_TOOL_DEFINITIONS: HarnessToolDefinition[] = [
  {
    name: "game_get_project_state",
    description:
      "Read current game project file list, spec.json, config.json, and assets.json summary.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "game_update_spec",
    description:
      "Validate and update spec.json (structured Game Design Spec card with mode, orientation, worldSize, maxPlayers, controls).",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description: "Complete GameSpec object conforming to GameSpecSchema.",
        },
      },
      required: ["spec"],
    },
  },
  {
    name: "game_search_assets",
    description:
      "Search the built-in CC0 2D sprite & procedural Web Audio SFX catalog by bilingual keywords (Chinese or English).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (e.g. 'spaceship star', '史莱姆 音效')" },
        kind: {
          type: "string",
          enum: ["sprite", "audio_sfx", "audio_bgm", "procedural_sfx"],
        },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "game_register_asset",
    description:
      "Register a CC0 catalog asset (by catalogId) or custom procedural asset into assets.json so game code can safely reference it.",
    inputSchema: {
      type: "object",
      properties: {
        catalogId: {
          type: "string",
          description: "ID from game_search_assets to auto-populate URL/preset.",
        },
        entry: {
          type: "object",
          description: "Optional explicit AssetEntry object if not using catalogId.",
        },
      },
    },
  },
  {
    name: "game_update_config",
    description: "Update tunable gameplay balance values in config.json.",
    inputSchema: {
      type: "object",
      properties: {
        values: {
          type: "object",
          description: "Key-value map of tunable numbers, booleans, or strings.",
        },
      },
      required: ["values"],
    },
  },
  {
    name: "game_read_file",
    description: "Read a text file inside the game project (e.g. simulation.ts, renderer.ts, spec.json).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "game_write_file",
    description: "Create or overwrite a file in the game project (e.g. simulation.ts, renderer.ts).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "game_apply_patch",
    description:
      "Apply an exact search-and-replace patch to an existing project file for fast incremental iterations.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        target: { type: "string", description: "Exact existing substring to replace" },
        replacement: { type: "string", description: "New replacement text" },
      },
      required: ["path", "target", "replacement"],
    },
  },
  {
    name: "game_verify",
    description:
      "Run L1 compile check (esbuild + headless isolation check), L2 workerd V8 isolate 120-tick smoke test, and optional L3 browser iframe probe.",
    inputSchema: {
      type: "object",
      properties: {
        ticks: { type: "number", description: "Ticks to simulate in workerd smoke test (default 120)" },
      },
    },
  },
];

export interface HarnessExecutorHooks {
  roomServerUrl?: string;
  onFileChanged?: (path: string, content: string) => void;
  onSpecUpdated?: (spec: GameSpec) => void;
  onVerifyCompleted?: (report: FullVerifyReport) => void;
  requestWebProbe?: () => Promise<RuntimeProbeResult | null>;
}

export interface HarnessToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export class HarnessToolExecutor {
  private readonly workspace: WorkspaceAdapter;
  private readonly hooks: HarnessExecutorHooks;

  constructor(workspace: WorkspaceAdapter, hooks: HarnessExecutorHooks = {}) {
    this.workspace = workspace;
    this.hooks = hooks;
  }

  async execute(name: string, rawArgs: Record<string, unknown> = {}): Promise<HarnessToolResult> {
    try {
      switch (name) {
        case "game_get_project_state": {
          const files = await this.workspace.listFiles();
          const specRaw = await this.workspace.readFile("spec.json");
          const configRaw = await this.workspace.readFile("config.json");
          const assetsRaw = await this.workspace.readFile("assets.json");
          return {
            ok: true,
            summary: `Project has ${files.length} files (${files.join(", ")})`,
            data: {
              files,
              spec: specRaw ? safeJsonParse(specRaw) : null,
              config: configRaw ? safeJsonParse(configRaw) : null,
              assets: assetsRaw ? safeJsonParse(assetsRaw) : null,
            },
          };
        }

        case "game_update_spec": {
          const parsed = GameSpecSchema.safeParse(rawArgs.spec);
          if (!parsed.success) {
            return {
              ok: false,
              summary: `Invalid spec.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            };
          }
          const formatted = JSON.stringify(parsed.data, null, 2);
          await this.workspace.writeFile("spec.json", formatted);
          this.hooks.onFileChanged?.("spec.json", formatted);
          this.hooks.onSpecUpdated?.(parsed.data);
          return {
            ok: true,
            summary: `Updated spec.json for "${parsed.data.title}" (${parsed.data.mode}, ${parsed.data.orientation})`,
            data: parsed.data,
          };
        }

        case "game_search_assets": {
          const query = String(rawArgs.query ?? "");
          const kind = rawArgs.kind as Parameters<typeof searchAssetCatalog>[1] extends infer O
            ? O extends { kind?: infer K }
              ? K
              : never
            : never;
          const limit = typeof rawArgs.limit === "number" ? rawArgs.limit : 8;
          const matches = searchAssetCatalog(query, { kind, limit }).map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            style: m.style,
            description: m.description,
            sfxPreset: m.sfxPreset,
            hasSpriteDataUri: Boolean(m.url),
          }));
          return {
            ok: true,
            summary: `Found ${matches.length} assets for "${query}"`,
            data: matches,
          };
        }

        case "game_register_asset": {
          let entryData = rawArgs.entry;
          if (typeof rawArgs.catalogId === "string") {
            const found = CC0_ASSET_CATALOG.find((c) => c.id === rawArgs.catalogId);
            if (!found) {
              return { ok: false, summary: `Catalog asset not found: ${rawArgs.catalogId}` };
            }
            entryData = catalogItemToAssetEntry(found);
          }
          const parsedEntry = AssetEntrySchema.safeParse(entryData);
          if (!parsedEntry.success) {
            return { ok: false, summary: `Invalid asset entry: ${parsedEntry.error.message}` };
          }
          const existingRaw = await this.workspace.readFile("assets.json");
          const existingParsed = AssetManifestSchema.safeParse(
            existingRaw ? safeJsonParse(existingRaw) : { version: 1, assets: [] },
          );
          const manifest = existingParsed.success
            ? existingParsed.data
            : { version: 1 as const, assets: [] };
          const idx = manifest.assets.findIndex((a) => a.id === parsedEntry.data.id);
          if (idx >= 0) manifest.assets[idx] = parsedEntry.data;
          else manifest.assets.push(parsedEntry.data);

          const formatted = JSON.stringify(manifest, null, 2);
          await this.workspace.writeFile("assets.json", formatted);
          this.hooks.onFileChanged?.("assets.json", formatted);
          return {
            ok: true,
            summary: `Registered asset "${parsedEntry.data.id}" (${parsedEntry.data.kind}) in assets.json`,
            data: parsedEntry.data,
          };
        }

        case "game_update_config": {
          const values = rawArgs.values as GameConfigValues | undefined;
          if (!values || typeof values !== "object" || Array.isArray(values)) {
            return { ok: false, summary: "values must be a key-value object" };
          }
          const existingRaw = await this.workspace.readFile("config.json");
          const existing = (existingRaw ? safeJsonParse(existingRaw) : {}) as GameConfigValues;
          const merged = { ...existing, ...values };
          const formatted = JSON.stringify(merged, null, 2);
          await this.workspace.writeFile("config.json", formatted);
          this.hooks.onFileChanged?.("config.json", formatted);
          return {
            ok: true,
            summary: `Updated config.json (${Object.keys(values).join(", ")})`,
            data: merged,
          };
        }

        case "game_read_file": {
          const p = String(rawArgs.path ?? "");
          const content = await this.workspace.readFile(p);
          if (content === null) {
            return { ok: false, summary: `File not found: ${p}` };
          }
          return { ok: true, summary: `Read ${p} (${content.length} chars)`, data: { path: p, content } };
        }

        case "game_write_file": {
          const p = String(rawArgs.path ?? "");
          const content = String(rawArgs.content ?? "");
          await this.workspace.writeFile(p, content);
          this.hooks.onFileChanged?.(p, content);
          return { ok: true, summary: `Wrote ${p} (${content.length} chars)`, data: { path: p } };
        }

        case "game_apply_patch": {
          const p = String(rawArgs.path ?? "");
          const target = String(rawArgs.target ?? "");
          const replacement = String(rawArgs.replacement ?? "");
          const current = await this.workspace.readFile(p);
          if (current === null) {
            return { ok: false, summary: `File not found: ${p}` };
          }
          if (!target || !current.includes(target)) {
            return { ok: false, summary: `Patch target text not found in ${p}` };
          }
          const updated = current.replace(target, replacement);
          await this.workspace.writeFile(p, updated);
          this.hooks.onFileChanged?.(p, updated);
          return { ok: true, summary: `Patched ${p} cleanly`, data: { path: p } };
        }

        case "game_verify": {
          const allFiles = await this.workspace.getAllFiles();
          const compiled = await compileProjectInNode(allFiles);
          const l1Compile = {
            ok: compiled.ok,
            durationMs: compiled.durationMs,
            diagnostics: compiled.diagnostics,
          };

          let l2Smoke: SmokeTestResponse | null = null;
          if (compiled.ok) {
            const specObj = (safeJsonParse(allFiles["spec.json"] ?? "{}") ?? {}) as Partial<GameSpec>;
            const configObj = (safeJsonParse(allFiles["config.json"] ?? "{}") ?? {}) as GameConfigValues;
            const roomServerUrl = this.hooks.roomServerUrl || process.env.ROOM_SERVER_URL || "http://127.0.0.1:4000";
            try {
              const res = await fetch(`${roomServerUrl}/api/verify/smoke`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  simBundle: compiled.simBundle,
                  spec: {
                    worldSize: specObj.worldSize ?? { width: 800, height: 600 },
                    tickRate: specObj.tickRate ?? 20,
                    mode: specObj.mode ?? "singleplayer",
                    maxPlayers: specObj.maxPlayers ?? 1,
                  },
                  config: configObj,
                  ticks: typeof rawArgs.ticks === "number" ? rawArgs.ticks : 120,
                }),
                signal: AbortSignal.timeout(8000),
              });
              if (res.ok) {
                l2Smoke = (await res.json()) as SmokeTestResponse;
              } else {
                l2Smoke = {
                  ok: false,
                  engine: "workerd",
                  ticksExecuted: 0,
                  durationMs: 0,
                  maxTickMs: 0,
                  stateBytes: 0,
                  diagnostics: [
                    {
                      layer: "L2_SMOKE",
                      severity: "error",
                      message: `room-server returned HTTP ${res.status}`,
                    },
                  ],
                };
              }
            } catch (err) {
              l2Smoke = {
                ok: false,
                engine: "workerd",
                ticksExecuted: 0,
                durationMs: 0,
                maxTickMs: 0,
                stateBytes: 0,
                diagnostics: [
                  {
                    layer: "L2_SMOKE",
                    severity: "error",
                    message: `Could not reach workerd room-server at ${roomServerUrl}: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
              };
            }
          }

          let l3Runtime: RuntimeProbeResult | null = null;
          if (compiled.ok && l2Smoke?.ok && this.hooks.requestWebProbe) {
            l3Runtime = await this.hooks.requestWebProbe().catch(() => null);
          }

          const report: FullVerifyReport = {
            ok: l1Compile.ok && Boolean(l2Smoke?.ok) && (l3Runtime ? l3Runtime.ok : true),
            l1Compile,
            l2Smoke,
            l3Runtime,
          };
          this.hooks.onVerifyCompleted?.(report);

          return {
            ok: report.ok,
            summary: report.ok
              ? `Verification PASSED (L1 ${l1Compile.durationMs}ms, L2 workerd ${l2Smoke?.ticksExecuted ?? 0} ticks max ${l2Smoke?.maxTickMs ?? 0}ms${l3Runtime ? `, L3 pixels ${(l3Runtime.nonZeroPixelRatio * 100).toFixed(1)}%` : ""})`
              : `Verification FAILED: ${[
                  ...l1Compile.diagnostics.map((d) => `[L1] ${d.message}`),
                  ...(l2Smoke?.diagnostics.map((d) => `[L2] ${d.message}`) ?? []),
                  ...(l3Runtime && !l3Runtime.ok
                    ? [`[L3] ${l3Runtime.blankCanvas ? "Blank canvas detected" : l3Runtime.errors.map((e) => e.message).join("; ")}`]
                    : []),
                ].join(" | ")}`,
            data: report,
          };
        }

        default:
          return { ok: false, summary: `Unknown harness tool: ${name}` };
      }
    } catch (err) {
      return {
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
