import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { CloudAgentEvent } from "@aa-game/protocol";
import {
  compileProjectInNode,
  HarnessToolExecutor,
  MemoryWorkspaceAdapter,
  runCloudAgentLoop,
  searchAssetCatalog,
} from "./index.js";

test("bilingual CC0 asset search finds sprites and procedural SFX", () => {
  const ships = searchAssetCatalog("飞船 spaceship");
  assert.ok(ships.some((a) => a.id === "cc0_neon_ship"));

  const sfx = searchAssetCatalog("爆炸", { kind: "procedural_sfx" });
  assert.ok(sfx.some((a) => a.id === "sfx_explosion"));
});

test("Node L1 bundler rejects forbidden pixi.js import inside simulation.ts", async () => {
  const res = await compileProjectInNode({
    "simulation.ts": `import { Graphics } from "pixi.js"; export function createSimulation() { return Graphics; }`,
    "renderer.ts": `export function createRenderer() { return { init() {}, render() {} }; }`,
  });
  assert.equal(res.ok, false);
  assert.ok(res.diagnostics.some((d) => d.message.includes("Forbidden import")));
});

test("HarnessToolExecutor registers CC0 assets, validates spec, and patches files", async () => {
  const ws = new MemoryWorkspaceAdapter({
    "simulation.ts": "export const SPEED = 200;\n",
    "assets.json": JSON.stringify({ version: 1, assets: [] }),
  });
  const executor = new HarnessToolExecutor(ws);

  const reg = await executor.execute("game_register_asset", { catalogId: "cc0_energy_star" });
  assert.equal(reg.ok, true);

  const patch = await executor.execute("game_apply_patch", {
    path: "simulation.ts",
    target: "SPEED = 200",
    replacement: "SPEED = 320",
  });
  assert.equal(patch.ok, true);
  assert.equal(await ws.readFile("simulation.ts"), "export const SPEED = 320;\n");

  const badSpec = await executor.execute("game_update_spec", { spec: { title: "" } });
  assert.equal(badSpec.ok, false);
});

test("Cloud/BYOK Agent loop executes Spec Card tool call against mock OpenAI API", async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      callCount += 1;
      res.setHeader("content-type", "application/json");
      if (callCount === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "game_update_spec",
                        arguments: JSON.stringify({
                          spec: {
                            id: "cyber-pong",
                            title: "Cyber Pong",
                            description: "2D 联机霓虹弹球对战",
                            mode: "multiplayer",
                            orientation: "landscape",
                            worldSize: { width: 800, height: 500 },
                            maxPlayers: 2,
                            minPlayersToStart: 2,
                            tickRate: 20,
                            controls: {
                              joystick: true,
                              pointer: false,
                              buttons: [{ id: "primary", label: "加速", keyHint: "Space" }],
                            },
                            hudMode: "hybrid",
                          },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "策划卡已生成，请确认后点击生成代码！",
                },
              },
            ],
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };

  try {
    const events: CloudAgentEvent[] = [];
    await runCloudAgentLoop(
      {
        workflowMode: "spec-confirm",
        phase: "spec",
        prompt: "帮我做一个双人联机霓虹弹球游戏",
        history: [],
        files: { "assets.json": JSON.stringify({ version: 1, assets: [] }) },
        configValues: {},
        modelConfig: {
          provider: "openai-compatible",
          baseUrl: `http://127.0.0.1:${addr.port}`,
          apiKey: "test-key",
          model: "mock-gpt",
        },
      },
      (ev) => events.push(ev),
    );

    assert.ok(events.some((e) => e.type === "spec_card" && e.spec.title === "Cyber Pong"));
    assert.ok(events.some((e) => e.type === "file_update" && e.path === "spec.json"));
    assert.ok(events.some((e) => e.type === "done"));
  } finally {
    server.close();
  }
});
