#!/usr/bin/env node
import { startHarnessMcpStdioServer } from "./index.js";

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const workspaceDir =
  parseArg("--workspace") || process.env.AA_GAME_WORKSPACE || process.cwd();
const roomServerUrl =
  parseArg("--room-server") || process.env.AA_ROOM_SERVER_URL || "http://127.0.0.1:4000";
const probeCallbackUrl = parseArg("--probe-url") || process.env.AA_PROBE_CALLBACK_URL;
const probeSecret = parseArg("--probe-secret") || process.env.AA_PROBE_SECRET;

startHarnessMcpStdioServer({
  workspaceDir,
  roomServerUrl,
  probeCallbackUrl,
  probeSecret,
});
