import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { BridgeServerMessage } from "@aa-game/protocol";
import { LocalBridgeServer } from "./bridge-server.js";

test("Local Bridge E2E: Origin guard + Pairing Token + ACP session + injected MCP + disk sync + L3 probe relay", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa-bridge-test-"));
  const bridge = new LocalBridgeServer({
    port: 0,
    token: "secret-pair-token",
    workspaceRoot: tmpRoot,
    roomServerUrl: "http://127.0.0.1:49999", // unreachable room server still returns structured L2 report cleanly
    allowedOrigins: ["http://localhost:3000"],
  });

  const info = await bridge.start();

  try {
    // 1. Security check: isolated player iframe origin (:3001) MUST be rejected with 403
    const forbiddenStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(info.url, { origin: "http://localhost:3001" });
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      ws.on("open", () => {
        ws.close();
        reject(new Error("Expected 403 Forbidden for player iframe origin"));
      });
      ws.on("error", () => {});
    });
    assert.equal(forbiddenStatus, 403);

    // 2. Connect with allowed Studio origin & authenticate
    const ws = new WebSocket(info.url, { origin: "http://localhost:3000" });
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });

    const received: BridgeServerMessage[] = [];
    const changedFiles = new Map<string, string>();
    let probeRequested = false;
    let permissionApproved = false;

    const waitFor = <T extends BridgeServerMessage["type"]>(
      type: T,
      timeoutMs = 10_000,
    ): Promise<Extract<BridgeServerMessage, { type: T }>> =>
      new Promise((resolve, reject) => {
        const existing = received.find((m) => m.type === type);
        if (existing) {
          resolve(existing as Extract<BridgeServerMessage, { type: T }>);
          return;
        }
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        const listener = (raw: Buffer) => {
          const parsed = JSON.parse(raw.toString("utf8")) as BridgeServerMessage;
          if (parsed.type === type) {
            clearTimeout(timer);
            ws.off("message", listener);
            resolve(parsed as Extract<BridgeServerMessage, { type: T }>);
          }
        };
        ws.on("message", listener);
      });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8")) as BridgeServerMessage;
      received.push(msg);

      if (msg.type === "local_file_changed") {
        changedFiles.set(msg.path, msg.content);
      } else if (msg.type === "acp_permission_request") {
        permissionApproved = true;
        ws.send(
          JSON.stringify({
            type: "acp_permission_response",
            requestId: msg.request.requestId,
            optionId: "allow_once",
          }),
        );
      } else if (msg.type === "request_web_probe") {
        probeRequested = true;
        ws.send(
          JSON.stringify({
            type: "web_probe_result",
            probeId: msg.probeId,
            result: {
              ok: true,
              blankCanvas: false,
              nonZeroPixelRatio: 0.42,
              errors: [],
              durationMs: 12,
            },
          }),
        );
      }
    });

    ws.send(JSON.stringify({ type: "auth", token: "secret-pair-token" }));
    const authOk = await waitFor("auth_ok");
    assert.ok(authOk.agents.some((a) => a.id === "builtin-demo-acp"));

    // 3. Sync project to local mirror directory
    ws.send(
      JSON.stringify({
        type: "sync_project",
        projectId: "demo-project",
        revision: 1,
        files: {
          "spec.json": JSON.stringify({
            id: "demo",
            title: "Demo",
            description: "Demo",
            mode: "singleplayer",
            orientation: "portrait",
            worldSize: { width: 540, height: 840 },
            maxPlayers: 1,
            minPlayersToStart: 1,
            tickRate: 30,
            controls: { joystick: true, pointer: false, buttons: [] },
            hudMode: "hybrid",
          }),
          "config.json": JSON.stringify({ playerSpeed: 300 }),
          "assets.json": JSON.stringify({ version: 1, assets: [] }),
          "simulation.ts": `export function createSimulation() { return { init() { return { ok: true }; }, onPlayerJoin() {}, onPlayerLeave() {}, onInput() {}, onTick() {} }; }`,
          "renderer.ts": `export function createRenderer() { return { init() {}, render() {} }; }`,
        },
      }),
    );
    const synced = await waitFor("project_synced");
    assert.ok(fs.existsSync(path.join(synced.workspaceDir, "simulation.ts")));

    // 4. Start ACP session (automatically spawns demo ACP agent + injects harness-mcp!)
    ws.send(
      JSON.stringify({
        type: "acp_start_session",
        projectId: "demo-project",
        agentId: "builtin-demo-acp",
      }),
    );
    const started = await waitFor("acp_session_started");
    assert.equal(started.mcpServerInjected, true);
    // Thin Editor compliance: AGENTS.md as single source of truth + thin @-import pointers
    assert.ok(fs.existsSync(path.join(synced.workspaceDir, "AGENTS.md")));
    assert.equal(fs.readFileSync(path.join(synced.workspaceDir, "CLAUDE.md"), "utf8").trim(), "@AGENTS.md");
    assert.equal(fs.readFileSync(path.join(synced.workspaceDir, "GEMINI.md"), "utf8").trim(), "@./AGENTS.md");

    // 5. Run ACP prompt -> verifies raw prompt passthrough + permission approval + MCP tools + disk sync!
    const rawPrompt = "给我加一个护盾资产并提高移动速度";
    ws.send(
      JSON.stringify({
        type: "acp_prompt",
        sessionId: started.sessionId,
        prompt: rawPrompt,
        workflowMode: "fast-direct",
        phase: "iterate",
      }),
    );

    const done = await waitFor("acp_prompt_done", 15_000);
    assert.equal(done.stopReason, "end_turn");
    assert.equal(permissionApproved, true);

    // Assert raw prompt was NOT wrapped with GAME_DEV_SKILL_MD or outer state-machine instructions
    const thoughtEvent = received.find(
      (m) => m.type === "acp_update" && m.update.sessionUpdate === "agent_thought_chunk",
    );
    assert.ok(thoughtEvent && thoughtEvent.type === "acp_update" && thoughtEvent.update.sessionUpdate === "agent_thought_chunk");
    assert.ok(
      thoughtEvent.update.content.text.includes(`(${rawPrompt.length}字): ${rawPrompt}`),
      `Expected verbatim Thin Editor prompt passthrough, got: ${thoughtEvent.update.content.text}`,
    );

    // Verify MCP tool changes synced back from disk to Web Workbench, without leaking guide files!
    assert.equal(changedFiles.has("AGENTS.md"), false);
    assert.equal(changedFiles.has("CLAUDE.md"), false);
    assert.equal(changedFiles.has("GEMINI.md"), false);
    assert.ok(changedFiles.has("assets.json"), "assets.json change should sync back from local disk");
    assert.ok(changedFiles.get("assets.json")!.includes("cc0_shield_orb"));
    assert.ok(changedFiles.has("config.json"), "config.json change should sync back from local disk");
    assert.ok(changedFiles.get("config.json")!.includes("360"));
    assert.equal(probeRequested, false); // L2 couldn't reach dummy port 49999 so L3 skipped cleanly

    ws.close();
  } finally {
    await bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
