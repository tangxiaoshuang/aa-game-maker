/**
 * Open-source workerd supervisor worker.
 * Dynamically instantiates isolated V8 workers via env.LOADER (workerLoader)
 * with globalOutbound: null (zero network, zero filesystem) for each game room
 * and each L2 headless smoke test.
 */

const ROOM_ISOLATE_HARNESS = `
import * as simMod from "./sim.js";

class SeededRng {
  constructor(seed) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min, max) { return min + this.next() * (max - min); }
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  pick(items) { return items[this.int(0, items.length - 1)]; }
}

function findNonFinite(value, path = "state") {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = findNonFinite(value[i], path + "[" + i + "]");
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const bad = findNonFinite(v, path + "." + k);
      if (bad) return bad;
    }
  }
  return null;
}

const createSim = simMod.createSimulation || (simMod.default && simMod.default.createSimulation) || simMod.default;
if (typeof createSim !== "function") {
  throw new Error("simulation.ts must export createSimulation()");
}

let sim = null;
let state = null;
let tick = 0;
let elapsedMs = 0;
let dt = 0.05;
let rng = new SeededRng(42);
let config = {};
let worldSize = { width: 800, height: 600 };
let events = [];

function makeCtx() {
  return {
    tick,
    elapsedMs,
    dt,
    rng,
    config,
    worldSize,
    emit(type, payload) {
      events.push({ type, payload });
    },
  };
}

function getSnapshot() {
  return sim.getPublicState ? sim.getPublicState(state) : state;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      const body = request.method === "POST" ? await request.json() : {};

      if (url.pathname === "/init") {
        sim = createSim();
        worldSize = body.worldSize || { width: 800, height: 600 };
        const tickRate = Math.max(10, Math.min(60, Number(body.tickRate || 20)));
        dt = 1 / tickRate;
        config = { ...(body.config || {}) };
        rng = new SeededRng(Number(body.seed || 20261125));
        tick = 0;
        elapsedMs = 0;
        events = [];
        state = sim.init(makeCtx());
        return Response.json({ ok: true, tick, state: getSnapshot(), events });
      }

      if (url.pathname === "/smoke") {
        const diagnostics = [];
        const start = Date.now();
        let maxTickMs = 0;
        let stateBytes = 0;
        let ticksExecuted = 0;
        try {
          sim = createSim();
          const spec = body.spec || { worldSize: { width: 800, height: 600 }, tickRate: 20, mode: "singleplayer", maxPlayers: 1 };
          worldSize = spec.worldSize || { width: 800, height: 600 };
          dt = 1 / Math.max(10, Math.min(60, Number(spec.tickRate || 20)));
          config = { ...(body.config || {}) };
          rng = new SeededRng(42);
          tick = 0;
          elapsedMs = 0;
          events = [];
          state = sim.init(makeCtx());

          const playerCount = spec.mode === "multiplayer" ? Math.min(2, Math.max(2, spec.maxPlayers || 2)) : 1;
          const colors = ["#38bdf8", "#f472b6", "#34d399", "#fbbf24"];
          for (let i = 0; i < playerCount; i += 1) {
            sim.onPlayerJoin(state, { id: "bot_" + (i + 1), name: "Bot " + (i + 1), color: colors[i % colors.length] }, makeCtx());
          }

          const ticksToRun = Math.min(240, Math.max(20, Number(body.ticks || 120)));
          for (let t = 0; t < ticksToRun; t += 1) {
            for (let i = 0; i < playerCount; i += 1) {
              const angle = t / 15 + i * Math.PI;
              sim.onInput(state, "bot_" + (i + 1), {
                moveX: Number(Math.cos(angle).toFixed(3)),
                moveY: Number(Math.sin(angle).toFixed(3)),
                primary: t % 25 === 0,
                secondary: t % 40 === 0,
                seq: t,
              }, makeCtx());
            }
            const t0 = performance.now();
            tick += 1;
            elapsedMs += dt * 1000;
            events = [];
            sim.onTick(state, makeCtx());
            const elapsedTick = performance.now() - t0;
            if (elapsedTick > maxTickMs) maxTickMs = elapsedTick;
            ticksExecuted += 1;

            if (t === 0 || t === ticksToRun - 1 || t % 30 === 0) {
              const snap = getSnapshot();
              const bad = findNonFinite(snap);
              if (bad) {
                diagnostics.push({
                  layer: "L2_SMOKE",
                  severity: "error",
                  message: "Detected non-finite number (NaN/Infinity) at " + bad + " on tick " + tick,
                });
                break;
              }
              const serialized = JSON.stringify(snap);
              stateBytes = serialized.length;
              if (stateBytes > 64 * 1024) {
                diagnostics.push({
                  layer: "L2_SMOKE",
                  severity: "warn",
                  message: "Snapshot size exceeds 64KB (" + stateBytes + " bytes)",
                });
              }
            }
          }

          if (playerCount > 1) {
            sim.onPlayerLeave(state, "bot_2", makeCtx());
            tick += 1;
            elapsedMs += dt * 1000;
            sim.onTick(state, makeCtx());
          }
        } catch (err) {
          diagnostics.push({
            layer: "L2_SMOKE",
            severity: "error",
            message: err && err.message ? err.message : String(err),
            detail: err && err.stack ? err.stack : undefined,
          });
        }
        return Response.json({
          ok: diagnostics.every((d) => d.severity !== "error"),
          engine: "workerd",
          ticksExecuted,
          durationMs: Date.now() - start,
          maxTickMs: Number(maxTickMs.toFixed(3)),
          stateBytes,
          diagnostics,
        });
      }

      if (!sim || !state) {
        return Response.json({ ok: false, error: "Room isolate not initialized" }, { status: 409 });
      }

      if (url.pathname === "/join") {
        events = [];
        sim.onPlayerJoin(state, body.player, makeCtx());
        return Response.json({ ok: true, tick, state: getSnapshot(), events });
      }

      if (url.pathname === "/leave") {
        events = [];
        sim.onPlayerLeave(state, body.playerId, makeCtx());
        return Response.json({ ok: true, tick, state: getSnapshot(), events });
      }

      if (url.pathname === "/input") {
        events = [];
        sim.onInput(state, body.playerId, body.input, makeCtx());
        return Response.json({ ok: true });
      }

      if (url.pathname === "/config") {
        events = [];
        config = { ...config, ...(body.config || {}) };
        if (sim.onConfigUpdate) {
          sim.onConfigUpdate(state, config, makeCtx());
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/tick") {
        events = [];
        if (Array.isArray(body.inputs)) {
          for (const item of body.inputs) {
            sim.onInput(state, item.playerId, item.input, makeCtx());
          }
        }
        tick += 1;
        elapsedMs += dt * 1000;
        sim.onTick(state, makeCtx());
        const snap = getSnapshot();
        return Response.json({ ok: true, tick, state: snap, events });
      }

      return Response.json({ ok: false, error: "Unknown isolate action" }, { status: 404 });
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : undefined,
        },
        { status: 500 },
      );
    }
  },
};
`;

const activeBundles = new Map();

function getRoomIsolate(env, isolateId, simBundle) {
  return env.LOADER.get(isolateId, async () => ({
    compatibilityDate: "2025-09-01",
    mainModule: "harness.js",
    modules: {
      "harness.js": ROOM_ISOLATE_HARNESS,
      "sim.js": simBundle,
    },
    // Strict zero-network sandbox: untrusted game code cannot make outbound fetch requests.
    globalOutbound: null,
  }));
}

async function callIsolate(worker, path, payload) {
  const entrypoint = typeof worker.getEntrypoint === "function" ? worker.getEntrypoint() : worker;
  return entrypoint.fetch("http://isolate" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        engine: "workerd",
        workerLoaderAvailable: Boolean(env.LOADER),
        activeBundles: activeBundles.size,
      });
    }

    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    try {
      const body = await request.json();

      if (url.pathname === "/smoke") {
        const isolateId = "smoke:" + Date.now() + ":" + Math.random().toString(36).slice(2, 8);
        const worker = getRoomIsolate(env, isolateId, body.simBundle);
        return await callIsolate(worker, "/smoke", {
          spec: body.spec,
          config: body.config,
          ticks: body.ticks,
        });
      }

      if (url.pathname === "/room/init") {
        const roomId = String(body.roomId);
        const version = Number(body.version || 1);
        const isolateId = "room:" + roomId + ":v" + version;
        activeBundles.set(roomId, { isolateId, simBundle: body.simBundle });
        const worker = getRoomIsolate(env, isolateId, body.simBundle);
        return await callIsolate(worker, "/init", {
          worldSize: body.worldSize,
          tickRate: body.tickRate,
          config: body.config,
          seed: body.seed,
        });
      }

      if (url.pathname === "/room/destroy") {
        activeBundles.delete(String(body.roomId));
        return Response.json({ ok: true });
      }

      const roomMatch = /^\/room\/(join|leave|input|config|tick)$/.exec(url.pathname);
      if (roomMatch) {
        const roomId = String(body.roomId);
        const entry = activeBundles.get(roomId);
        if (!entry) {
          return Response.json({ ok: false, error: "Room bundle not registered in workerd" }, { status: 404 });
        }
        const worker = getRoomIsolate(env, entry.isolateId, entry.simBundle);
        return await callIsolate(worker, "/" + roomMatch[1], body);
      }

      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : undefined,
        },
        { status: 500 },
      );
    }
  },
};
