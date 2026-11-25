import zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  content: Buffer | string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Pure-Node standard PKZIP creator (deflate compression, zero native deps)
 * for one-click project source export.
 */
export function buildZipBuffer(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/^\/+/, ""), "utf8");
    const rawBuf = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const compressed = zlib.deflateRawSync(rawBuf);
    const checksum = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * Generates a self-contained single-file HTML export of any game project.
 */
export function buildStandaloneHtml(params: {
  title: string;
  spec: unknown;
  configValues: unknown;
  assets: unknown;
  simBundle: string;
  clientBundle: string;
}): string {
  const safeJson = (v: unknown) => JSON.stringify(v).replace(/<\//g, "<\\/");
  const safeScript = (code: string) => JSON.stringify(code).replace(/<\//g, "<\\/");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
  <title>${params.title.replace(/</g, "&lt;")}</title>
  <style>
    html, body { margin:0; padding:0; width:100%; height:100dvh; overflow:hidden; background:#070b18; color:#f8fafc; font-family:system-ui,-apple-system,sans-serif; touch-action:none; user-select:none; }
    #stage { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; }
    #hud, #controls { position:fixed; inset:0; pointer-events:none; }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="hud"></div>
  <div id="controls"></div>
  <script type="module">
    import * as PIXI from "https://cdn.jsdelivr.net/npm/pixi.js@8.9.2/dist/pixi.mjs";

    const SPEC = ${safeJson(params.spec)};
    const CONFIG = ${safeJson(params.configValues)};
    const ASSETS = ${safeJson(params.assets)};
    const SIM_CODE = ${safeScript(params.simBundle)};
    const CLIENT_CODE = ${safeScript(params.clientBundle)};

    function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpPos(prev, curr, alpha) { return prev ? { x: lerp(prev.x, curr.x, alpha), y: lerp(prev.y, curr.y, alpha) } : curr; }
    function distance(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
    function normalize(x, y) { const l = Math.hypot(x, y); return l <= 1e-6 ? { x:0, y:0 } : l <= 1 ? { x, y } : { x:x/l, y:y/l }; }
    function circleOverlap(ax, ay, ar, bx, by, br) { const dx = bx - ax, dy = by - ay, r = ar + br; return dx*dx + dy*dy <= r*r; }
    function aabbOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
    class SeededRng {
      constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
      next() { this.s = (this.s + 0x6d2b79f5) >>> 0; let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
      range(a, b) { return a + this.next() * (b - a); }
      int(a, b) { return Math.floor(this.range(a, b + 1)); }
      pick(arr) { return arr[this.int(0, arr.length - 1)]; }
    }

    globalThis.__AA_PIXI__ = PIXI;
    globalThis.__AA_SDK__ = { SeededRng, clamp, lerp, lerpPos, distance, normalize, circleOverlap, aabbOverlap };

    async function importStr(code) {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      return await import(url);
    }

    let audioCtx = null;
    const audio = {
      play(preset) {
        try {
          audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
          if (audioCtx.state === "suspended") audioCtx.resume();
          const now = audioCtx.currentTime;
          const g = audioCtx.createGain(); g.connect(audioCtx.destination);
          const o = audioCtx.createOscillator(); o.connect(g);
          o.type = preset === "hit" ? "square" : "triangle";
          o.frequency.setValueAtTime(preset === "coin" ? 780 : preset === "hit" ? 180 : 480, now);
          o.frequency.exponentialRampToValueAtTime(preset === "coin" ? 1280 : 120, now + 0.14);
          g.gain.setValueAtTime(0.18, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
          o.start(now); o.stop(now + 0.17);
        } catch {}
      }
    };

    const keys = new Set();
    window.addEventListener("keydown", (e) => keys.add(e.code));
    window.addEventListener("keyup", (e) => keys.delete(e.code));

    const stageEl = document.getElementById("stage");
    const hudEl = document.getElementById("hud");
    const app = new PIXI.Application();
    await app.init({ width: window.innerWidth, height: window.innerHeight, backgroundColor: 0x070b18, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
    stageEl.appendChild(app.canvas);
    const worldLayer = new PIXI.Container();
    const hudLayer = new PIXI.Container();
    app.stage.addChild(worldLayer, hudLayer);

    const fit = () => {
      app.renderer.resize(window.innerWidth, window.innerHeight);
      const s = Math.min(window.innerWidth / SPEC.worldSize.width, window.innerHeight / SPEC.worldSize.height);
      worldLayer.scale.set(s);
      worldLayer.position.set((window.innerWidth - SPEC.worldSize.width * s) / 2, (window.innerHeight - SPEC.worldSize.height * s) / 2);
    };
    fit();
    window.addEventListener("resize", fit);

    const simMod = await importStr(SIM_CODE);
    const clientMod = await importStr(CLIENT_CODE);
    const sim = (simMod.createSimulation || simMod.default)();
    const renderer = (clientMod.createRenderer || clientMod.default)();

    const dt = 1 / (SPEC.tickRate || 30);
    const rng = new SeededRng(Date.now());
    let tick = 0, elapsedMs = 0, events = [];
    const makeSimCtx = () => ({ tick, elapsedMs, dt, rng, config: CONFIG, worldSize: SPEC.worldSize, emit(type, payload) { events.push({ type, payload }); } });
    const renderCtx = { app, worldLayer, hudLayer, hudDomRoot: hudEl, worldSize: SPEC.worldSize, localPlayerId: "local", audio, assets: ASSETS, config: CONFIG, isMobile: "ontouchstart" in window };

    await renderer.init(renderCtx);
    const state = sim.init(makeSimCtx());
    sim.onPlayerJoin(state, { id: "local", name: "Player", color: "#38bdf8" }, makeSimCtx());
    let currSnap = structuredClone(sim.getPublicState ? sim.getPublicState(state) : state);
    let prevSnap = currSnap;
    let lastSnapTime = performance.now();

    setInterval(() => {
      let mx = 0, my = 0;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
      if (keys.has("KeyW") || keys.has("ArrowUp")) my -= 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) my += 1;
      const d = normalize(mx, my);
      sim.onInput(state, "local", { moveX: d.x, moveY: d.y, primary: keys.has("Space"), secondary: keys.has("ShiftLeft"), seq: tick }, makeSimCtx());
      tick += 1; elapsedMs += dt * 1000; events = [];
      sim.onTick(state, makeSimCtx());
      prevSnap = currSnap;
      currSnap = structuredClone(sim.getPublicState ? sim.getPublicState(state) : state);
      lastSnapTime = performance.now();
      for (const ev of events) renderer.onEvent?.(ev, renderCtx);
    }, Math.round(dt * 1000));

    const raf = () => {
      requestAnimationFrame(raf);
      const alpha = clamp((performance.now() - lastSnapTime) / (dt * 1000), 0, 1);
      renderer.render(currSnap, prevSnap, alpha, renderCtx);
    };
    requestAnimationFrame(raf);
  </script>
</body>
</html>`;
}
