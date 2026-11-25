import * as esbuild from "esbuild-wasm";
import type { VerifyDiagnostic } from "@aa-game/protocol";

let initPromise: Promise<void> | null = null;

async function ensureEsbuildReady(): Promise<void> {
  if (!initPromise) {
    initPromise = esbuild.initialize({
      wasmURL: "/esbuild.wasm",
      worker: true,
    });
  }
  await initPromise;
}

const HEADLESS_SHIM = `
export class SeededRng {
  constructor(seed) { this.state = (seed >>> 0) || 0x9e3779b9; }
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min, max) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
}
export function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function distance(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
export function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len <= 1e-6) return { x: 0, y: 0 };
  return len <= 1 ? { x, y } : { x: x / len, y: y / len };
}
export function circleOverlap(ax, ay, ar, bx, by, br) {
  const dx = bx - ax, dy = by - ay, r = ar + br;
  return dx * dx + dy * dy <= r * r;
}
export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
`;

const PIXI_SHIM = `
const P = globalThis.__AA_PIXI__;
export const Application = P.Application;
export const Assets = P.Assets;
export const Container = P.Container;
export const Graphics = P.Graphics;
export const Sprite = P.Sprite;
export const Text = P.Text;
export const TextStyle = P.TextStyle;
export const Texture = P.Texture;
export const TilingSprite = P.TilingSprite;
export default P;
`;

const CLIENT_SDK_SHIM = `
const S = globalThis.__AA_SDK__;
export const SeededRng = S.SeededRng;
export const clamp = S.clamp;
export const lerp = S.lerp;
export const lerpPos = S.lerpPos;
export const distance = S.distance;
export const normalize = S.normalize;
export const circleOverlap = S.circleOverlap;
export const aabbOverlap = S.aabbOverlap;
export default S;
`;

function createVirtualFsPlugin(
  files: Record<string, string>,
  target: "sim" | "client",
): esbuild.Plugin {
  return {
    name: `aa-virtual-fs-${target}`,
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "@aa-game/game-sdk/headless") {
          return { path: args.path, namespace: "aa-shim" };
        }
        if (args.path === "pixi.js" || args.path === "@aa-game/game-sdk") {
          if (target === "sim") {
            return {
              errors: [
                {
                  text: `Forbidden import "${args.path}" inside headless simulation.ts (must have zero DOM/Pixi dependencies for workerd isolate).`,
                },
              ],
            };
          }
          return { path: args.path, namespace: "aa-shim" };
        }
        const cleaned = args.path.replace(/^\.\//, "");
        const candidates = [cleaned, `${cleaned}.ts`, `${cleaned}.js`, `${cleaned}.json`];
        for (const c of candidates) {
          if (Object.prototype.hasOwnProperty.call(files, c)) {
            return { path: c, namespace: "aa-vfs" };
          }
        }
        return { errors: [{ text: `Module not found in project virtual filesystem: ${args.path}` }] };
      });

      build.onLoad({ filter: /.*/, namespace: "aa-shim" }, (args) => {
        if (args.path === "@aa-game/game-sdk/headless") {
          return { contents: HEADLESS_SHIM, loader: "js" };
        }
        if (args.path === "pixi.js") {
          return { contents: PIXI_SHIM, loader: "js" };
        }
        return { contents: CLIENT_SDK_SHIM, loader: "js" };
      });

      build.onLoad({ filter: /.*/, namespace: "aa-vfs" }, (args) => {
        const contents = files[args.path] ?? "";
        const loader = args.path.endsWith(".json")
          ? "json"
          : args.path.endsWith(".ts")
            ? "ts"
            : "js";
        return { contents, loader };
      });
    },
  };
}

export interface CompileProjectResult {
  ok: boolean;
  simBundle: string;
  clientBundle: string;
  durationMs: number;
  diagnostics: VerifyDiagnostic[];
}

export async function compileGameProject(
  files: Record<string, string>,
): Promise<CompileProjectResult> {
  const t0 = performance.now();
  const diagnostics: VerifyDiagnostic[] = [];
  await ensureEsbuildReady();

  let simBundle = "";
  let clientBundle = "";

  const runTarget = async (entry: string, target: "sim" | "client"): Promise<string> => {
    try {
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        target: "es2022",
        plugins: [createVirtualFsPlugin(files, target)],
      });
      for (const w of result.warnings) {
        diagnostics.push({
          layer: "L1_COMPILE",
          severity: "warn",
          message: w.text,
          file: w.location?.file,
          line: w.location?.line,
        });
      }
      return result.outputFiles?.[0]?.text ?? "";
    } catch (err) {
      const buildFailure = err as esbuild.BuildFailure;
      if (Array.isArray(buildFailure.errors) && buildFailure.errors.length > 0) {
        for (const e of buildFailure.errors) {
          diagnostics.push({
            layer: "L1_COMPILE",
            severity: "error",
            message: e.text,
            file: e.location?.file ?? entry,
            line: e.location?.line,
          });
        }
      } else {
        diagnostics.push({
          layer: "L1_COMPILE",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
          file: entry,
        });
      }
      return "";
    }
  };

  simBundle = await runTarget("simulation.ts", "sim");
  clientBundle = await runTarget("renderer.ts", "client");

  return {
    ok: diagnostics.every((d) => d.severity !== "error") && Boolean(simBundle) && Boolean(clientBundle),
    simBundle,
    clientBundle,
    durationMs: Number((performance.now() - t0).toFixed(2)),
    diagnostics,
  };
}
