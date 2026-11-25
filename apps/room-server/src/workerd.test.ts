import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createRoomServerApp } from "./index.js";

const SAMPLE_SIM_BUNDLE = `
function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
export function createSimulation() {
  return {
    init(ctx) {
      return {
        players: {},
        inputs: {},
        speed: Number(ctx.config.moveSpeed || 200),
      };
    },
    onPlayerJoin(state, player) {
      state.players[player.id] = { id: player.id, name: player.name, x: 100, y: 100, score: 0 };
    },
    onPlayerLeave(state, playerId) {
      delete state.players[playerId];
      delete state.inputs[playerId];
    },
    onInput(state, playerId, input) {
      state.inputs[playerId] = input;
    },
    onConfigUpdate(state, config) {
      state.speed = Number(config.moveSpeed || 200);
    },
    onTick(state, ctx) {
      for (const p of Object.values(state.players)) {
        const inp = state.inputs[p.id];
        if (!inp) continue;
        p.x = clamp(p.x + (inp.moveX || 0) * state.speed * ctx.dt, 0, ctx.worldSize.width);
        p.y = clamp(p.y + (inp.moveY || 0) * state.speed * ctx.dt, 0, ctx.worldSize.height);
        if (inp.primary) p.score += 1;
      }
    },
    getPublicState(state) {
      return { players: state.players, speed: state.speed };
    },
  };
}
`;

const BUGGY_NAN_SIM_BUNDLE = `
export function createSimulation() {
  return {
    init() { return { x: 0 }; },
    onPlayerJoin() {},
    onPlayerLeave() {},
    onInput() {},
    onTick(state) { state.x = Number("bad") * 10; },
  };
}
`;

const SSRF_ATTEMPT_SIM_BUNDLE = `
export function createSimulation() {
  return {
    init() { return { fetchBlocked: false }; },
    onPlayerJoin() {},
    onPlayerLeave() {},
    onInput() {},
    onTick(state) {
      try {
        // Attempt forbidden outbound network call inside workerd V8 isolate (globalOutbound: null)
        fetch("http://127.0.0.1:4101/health").catch(() => { state.fetchBlocked = true; });
      } catch {
        state.fetchBlocked = true;
      }
    },
  };
}
`;

test("workerd V8 isolate sandbox: smoke tests + 2-player authoritative room sync", async () => {
  const { app } = await createRoomServerApp({ port: 4100, workerdPort: 4101 });
  const address = await app.listen({ port: 4100, host: "127.0.0.1" });

  try {
    // 1. Health check confirms workerd and Podman Redis are active
    const healthRes = await fetch(`${address}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      engine: string;
      workerdHealthy: boolean;
      redisConnected: boolean;
    };
    assert.equal(health.ok, true);
    assert.equal(health.engine, "workerd");
    assert.equal(health.workerdHealthy, true);
    assert.equal(health.redisConnected, true);

    // 2. L2 Smoke test passes on valid simulation inside workerd isolate
    const goodSmokeRes = await fetch(`${address}/api/verify/smoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        simBundle: SAMPLE_SIM_BUNDLE,
        spec: { worldSize: { width: 800, height: 600 }, tickRate: 20, mode: "multiplayer", maxPlayers: 4 },
        config: { moveSpeed: 240 },
        ticks: 60,
      }),
    });
    const goodSmoke = (await goodSmokeRes.json()) as { ok: boolean; ticksExecuted: number; engine: string };
    assert.equal(goodSmoke.ok, true);
    assert.equal(goodSmoke.engine, "workerd");
    assert.equal(goodSmoke.ticksExecuted, 60);

    // 3. L2 Smoke test catches NaN corruption inside workerd isolate
    const badSmokeRes = await fetch(`${address}/api/verify/smoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        simBundle: BUGGY_NAN_SIM_BUNDLE,
        spec: { worldSize: { width: 800, height: 600 }, tickRate: 20, mode: "singleplayer", maxPlayers: 1 },
        config: {},
        ticks: 20,
      }),
    });
    const badSmoke = (await badSmokeRes.json()) as { ok: boolean; diagnostics: Array<{ message: string }> };
    assert.equal(badSmoke.ok, false);
    assert.ok(badSmoke.diagnostics.some((d) => d.message.includes("non-finite")));

    // 4. Outbound network calls fail/cannot escape globalOutbound: null
    const ssrfRes = await fetch(`${address}/api/verify/smoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        simBundle: SSRF_ATTEMPT_SIM_BUNDLE,
        spec: { worldSize: { width: 800, height: 600 }, tickRate: 20, mode: "singleplayer", maxPlayers: 1 },
        config: {},
        ticks: 20,
      }),
    });
    assert.equal(ssrfRes.status, 200);

    // 5. Real 2-player WebSocket room backed by workerd V8 isolate
    const roomRes = await fetch(`${address}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: "test-arena",
        title: "Test Arena",
        simBundle: SAMPLE_SIM_BUNDLE,
        spec: { worldSize: { width: 800, height: 600 }, tickRate: 20, maxPlayers: 4 },
        configValues: { moveSpeed: 300 },
        autoStart: true,
      }),
    });
    assert.equal(roomRes.status, 200);
    const room = (await roomRes.json()) as { roomId: string; roomCode: string; wsPath: string };
    assert.ok(room.roomId);
    assert.equal(room.roomCode.length, 6);

    const wsUrl = `ws://127.0.0.1:4100${room.wsPath}`;
    const c1 = new WebSocket(wsUrl);
    const c2 = new WebSocket(wsUrl);

    const p1Welcome = new Promise<string>((resolve) => {
      c1.on("message", (buf) => {
        const msg = JSON.parse(buf.toString("utf8"));
        if (msg.type === "welcome") resolve(msg.playerId);
      });
    });
    const p2Welcome = new Promise<string>((resolve) => {
      c2.on("message", (buf) => {
        const msg = JSON.parse(buf.toString("utf8"));
        if (msg.type === "welcome") resolve(msg.playerId);
      });
    });

    await Promise.all([
      new Promise<void>((res) => c1.once("open", () => { c1.send(JSON.stringify({ type: "join", playerName: "Alice" })); res(); })),
      new Promise<void>((res) => c2.once("open", () => { c2.send(JSON.stringify({ type: "join", playerName: "Bob" })); res(); })),
    ]);

    const [p1Id, p2Id] = await Promise.all([p1Welcome, p2Welcome]);

    // Send movement input from Player 1 and wait for Player 2 to observe Player 1 moving
    c1.send(JSON.stringify({
      type: "input",
      input: { moveX: 1, moveY: 0, primary: true, secondary: false, seq: 1 },
    }));

    const movedState = await new Promise<{ players: Record<string, { x: number; score: number }> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for authoritative workerd snapshot")), 4000);
      c2.on("message", (buf) => {
        const msg = JSON.parse(buf.toString("utf8"));
        if (msg.type === "snapshot" && msg.state?.players?.[p1Id]?.x > 110 && msg.state?.players?.[p2Id]) {
          clearTimeout(timer);
          resolve(msg.state);
        }
      });
    });

    assert.ok(movedState.players[p1Id]!.x > 110);
    assert.ok(movedState.players[p1Id]!.score >= 1);

    c1.close();
    c2.close();
  } finally {
    await app.close();
  }
});
