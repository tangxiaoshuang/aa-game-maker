import crypto from "node:crypto";

/**
 * Generates a transparent-background stylized SVG sprite (or calls an optional
 * OpenAI-compatible Images API with transparent background support).
 */
export async function generateSpriteAsset(params: {
  prompt: string;
  style: "neon" | "pixel" | "cartoon";
  removeBg: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<{ buffer: Buffer; mimeType: string; ext: string; source: "generated" }> {
  // 1. If user supplied an Image API Key, call OpenAI-compatible Images API with transparent bg
  if (params.apiKey && params.apiKey.trim()) {
    const endpoint = `${(params.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/images/generations`;
    const styledPrompt = `2D top-down game sprite icon of ${params.prompt}, ${params.style} game art style, centered, crisp silhouette${params.removeBg ? ", isolated on transparent background, no background clutter" : ""}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: params.model || "gpt-image-1",
        prompt: styledPrompt,
        size: "1024x1024",
        ...(params.removeBg ? { background: "transparent" } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Image generation API failed (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const first = data.data?.[0];
    if (first?.b64_json) {
      return {
        buffer: Buffer.from(first.b64_json, "base64"),
        mimeType: "image/png",
        ext: "png",
        source: "generated",
      };
    }
    if (first?.url) {
      const imgRes = await fetch(first.url);
      const arr = Buffer.from(await imgRes.arrayBuffer());
      return { buffer: arr, mimeType: "image/png", ext: "png", source: "generated" };
    }
  }

  // 2. Built-in instant procedural transparent SVG sprite generator (zero API cost fallback)
  const hash = crypto.createHash("sha256").update(`${params.prompt}:${params.style}`).digest();
  const palettes = [
    ["#38bdf8", "#0284c7", "#e0f2fe"],
    ["#f472b6", "#db2777", "#fce7f3"],
    ["#34d399", "#059669", "#d1fae5"],
    ["#fbbf24", "#d97706", "#fef3c7"],
    ["#a78bfa", "#7c3aed", "#ede9fe"],
    ["#fb7185", "#e11d48", "#ffe4e6"],
  ];
  const [primary, secondary, accent] = palettes[hash[0]! % palettes.length]!;
  const label = params.prompt.slice(0, 8).replace(/[<>&"]/g, "");

  let bodySvg = "";
  if (params.style === "pixel") {
    const cells: string[] = [];
    for (let y = 1; y < 7; y += 1) {
      for (let x = 1; x < 4; x += 1) {
        const bit = hash[(y * 3 + x) % hash.length]! % 3;
        if (bit !== 0) {
          const fill = bit === 1 ? primary : accent;
          cells.push(`<rect x="${x * 8}" y="${y * 8}" width="8" height="8" fill="${fill}"/>`);
          cells.push(`<rect x="${(7 - x) * 8}" y="${y * 8}" width="8" height="8" fill="${fill}"/>`);
        }
      }
    }
    bodySvg = cells.join("");
  } else if (params.style === "cartoon") {
    bodySvg = `
      <ellipse cx="32" cy="36" rx="22" ry="18" fill="${primary}" stroke="${accent}" stroke-width="3"/>
      <circle cx="24" cy="32" r="4" fill="#0f172a"/><circle cx="40" cy="32" r="4" fill="#0f172a"/>
      <circle cx="25" cy="30.5" r="1.4" fill="#ffffff"/><circle cx="41" cy="30.5" r="1.4" fill="#ffffff"/>
      <path d="M25,42 Q32,48 39,42" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round"/>
    `;
  } else {
    bodySvg = `
      <polygon points="32,5 56,24 47,56 17,56 8,24" fill="${secondary}" fill-opacity="0.35" stroke="${primary}" stroke-width="3"/>
      <polygon points="32,13 48,26 42,48 22,48 16,26" fill="${primary}" stroke="${accent}" stroke-width="2"/>
      <circle cx="32" cy="32" r="7" fill="${accent}"/>
    `;
  }

  const bgRect = params.removeBg ? "" : `<rect width="64" height="64" rx="12" fill="#0f172a"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128" data-prompt="${label}">${bgRect}${bodySvg}</svg>`;

  return {
    buffer: Buffer.from(svg, "utf8"),
    mimeType: "image/svg+xml",
    ext: "svg",
    source: "generated",
  };
}
