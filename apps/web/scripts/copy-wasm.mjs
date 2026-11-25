import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
fs.mkdirSync(publicDir, { recursive: true });

const wasmSrc = require.resolve("esbuild-wasm/esbuild.wasm");
const wasmDst = path.resolve(publicDir, "esbuild.wasm");
fs.copyFileSync(wasmSrc, wasmDst);
console.log(`[web] Copied esbuild.wasm to ${wasmDst}`);
