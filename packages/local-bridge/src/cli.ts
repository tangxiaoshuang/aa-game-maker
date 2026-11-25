#!/usr/bin/env node
import { discoverLocalAcpAgents, LocalBridgeServer } from "./index.js";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const port = Number(parseArg("--port") || process.env.AA_BRIDGE_PORT || 4318);
const token = parseArg("--token") || process.env.AA_BRIDGE_TOKEN;
const roomServerUrl =
  parseArg("--room-server") || process.env.ROOM_SERVER_URL || "http://127.0.0.1:4000";
const extraOrigin = parseArg("--allow-origin");

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...(extraOrigin ? [extraOrigin] : []),
];

const server = new LocalBridgeServer({
  port,
  token,
  roomServerUrl,
  allowedOrigins,
});

const info = await server.start();
const agents = discoverLocalAcpAgents();

console.log("");
console.log("==============================================================");
console.log("  AA Game Maker — Local ACP Agent Bridge (v0.1.0)");
console.log("==============================================================");
console.log(`  WebSocket URL : ${info.url}`);
console.log(`  Pairing Token : ${info.token}`);
console.log(`  Room Server   : ${roomServerUrl}`);
console.log(`  Workspace Dir : ${server.workspaceRoot}`);
console.log("--------------------------------------------------------------");
console.log("  Detected Local ACP Agents:");
for (const a of agents) {
  console.log(`    [${a.available ? "READY" : "NOT FOUND"}] ${a.id} — ${a.name}`);
}
console.log("==============================================================");
console.log("  请在 Web 工作台左侧切换到「本地 ACP Agent」并填入上方 Token 连接");
console.log("");

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
