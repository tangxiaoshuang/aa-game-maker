import type { AssetEntry } from "@aa-game/protocol";

export interface CatalogAssetItem {
  id: string;
  name: string;
  kind: AssetEntry["kind"];
  source: AssetEntry["source"];
  style: "neon" | "pixel" | "cartoon" | "arcade";
  tags: string[];
  description: string;
  url?: string;
  sfxPreset?: AssetEntry["sfxPreset"];
  width?: number;
  height?: number;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

export const CC0_ASSET_CATALOG: CatalogAssetItem[] = [
  {
    id: "cc0_neon_ship",
    name: "霓虹星际飞船 / Neon Spaceship",
    kind: "sprite",
    source: "cc0",
    style: "neon",
    tags: ["ship", "spaceship", "player", "scifi", "neon", "飞船", "主角", "科幻", "射击"],
    description: "青蓝发光三角星际飞船精灵图 (64x64)",
    width: 64,
    height: 64,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><polygon points="32,6 56,54 32,44 8,54" fill="#38bdf8" stroke="#e0f2fe" stroke-width="3"/><circle cx="32" cy="30" r="7" fill="#0f172a"/><circle cx="32" cy="30" r="3" fill="#22d3ee"/></svg>`,
    ),
  },
  {
    id: "cc0_meteor_rock",
    name: "熔岩陨石 / Lava Meteor",
    kind: "sprite",
    source: "cc0",
    style: "neon",
    tags: ["meteor", "asteroid", "enemy", "hazard", "rock", "陨石", "障碍", "敌人", "太空"],
    description: "红橙色发光陨石障碍精灵图 (64x64)",
    width: 64,
    height: 64,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><polygon points="32,6 52,16 58,38 44,56 20,54 8,36 14,16" fill="#f43f5e" stroke="#fda4af" stroke-width="3"/><circle cx="26" cy="26" r="6" fill="#be123c"/><circle cx="40" cy="38" r="5" fill="#be123c"/></svg>`,
    ),
  },
  {
    id: "cc0_energy_star",
    name: "高能星核 / Energy Star",
    kind: "sprite",
    source: "cc0",
    style: "neon",
    tags: ["star", "coin", "pickup", "collectible", "gold", "星星", "星核", "金币", "收集", "道具"],
    description: "金黄色发光五角星收集物 (48x48)",
    width: 48,
    height: 48,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><polygon points="24,4 30,17 44,18 33,28 36,42 24,35 12,42 15,28 4,18 18,17" fill="#fde047" stroke="#fef9c3" stroke-width="2.5"/></svg>`,
    ),
  },
  {
    id: "cc0_slime_enemy",
    name: "霓虹史莱姆 / Neon Slime",
    kind: "sprite",
    source: "cc0",
    style: "cartoon",
    tags: ["slime", "monster", "enemy", "cute", "rpg", "史莱姆", "怪物", "敌人", "卡通"],
    description: "绿色弹性史莱姆怪物 (64x64)",
    width: 64,
    height: 64,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10,46 C10,20 20,12 32,12 C44,12 54,20 54,46 C54,54 46,56 32,56 C18,56 10,54 10,46 Z" fill="#34d399" stroke="#a7f3d0" stroke-width="3"/><circle cx="24" cy="34" r="4" fill="#0f172a"/><circle cx="40" cy="34" r="4" fill="#0f172a"/></svg>`,
    ),
  },
  {
    id: "cc0_hero_knight",
    name: "像素勇士 / Pixel Hero",
    kind: "sprite",
    source: "cc0",
    style: "pixel",
    tags: ["hero", "knight", "player", "character", "platformer", "勇士", "主角", "角色", "像素"],
    description: "简洁像素风冒险角色 (64x64)",
    width: 64,
    height: 64,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="18" y="10" width="28" height="22" rx="4" fill="#60a5fa"/><rect x="22" y="18" width="6" height="6" fill="#0f172a"/><rect x="36" y="18" width="6" height="6" fill="#0f172a"/><rect x="16" y="32" width="32" height="22" rx="4" fill="#3b82f6"/></svg>`,
    ),
  },
  {
    id: "cc0_shield_orb",
    name: "护盾道具 / Shield Powerup",
    kind: "sprite",
    source: "cc0",
    style: "neon",
    tags: ["shield", "buff", "powerup", "defense", "护盾", "增益", "道具", "防御"],
    description: "紫色能量护盾徽章 (48x48)",
    width: 48,
    height: 48,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24,4 L40,12 V24 C40,34 32,41 24,44 C16,41 8,34 8,24 V12 Z" fill="#a78bfa" stroke="#ede9fe" stroke-width="3"/></svg>`,
    ),
  },
  {
    id: "cc0_heart_life",
    name: "生命红心 / Heart Life",
    kind: "sprite",
    source: "cc0",
    style: "cartoon",
    tags: ["heart", "hp", "life", "heal", "ui", "红心", "生命", "血量", "治疗"],
    description: "红心生命图标 (48x48)",
    width: 48,
    height: 48,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24,42 C24,42 6,30 6,17 C6,10 11,6 17,6 C20.5,6 23,8 24,10.5 C25,8 27.5,6 31,6 C37,6 42,10 42,17 C42,30 24,42 24,42 Z" fill="#fb7185" stroke="#ffe4e6" stroke-width="2.5"/></svg>`,
    ),
  },
  {
    id: "cc0_laser_bolt",
    name: "激光弹幕 / Laser Bolt",
    kind: "sprite",
    source: "cc0",
    style: "neon",
    tags: ["laser", "bullet", "projectile", "shoot", "子弹", "激光", "弹幕", "射击"],
    description: "亮青色脉冲激光弹 (24x48)",
    width: 24,
    height: 48,
    url: svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 48"><rect x="7" y="4" width="10" height="40" rx="5" fill="#22d3ee" stroke="#ecfeff" stroke-width="2"/></svg>`,
    ),
  },
  {
    id: "sfx_coin",
    name: "收集得分音效 / Coin Pickup SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "coin", "star", "pickup", "score", "音效", "金币", "得分", "收集"],
    description: "清脆上扬街机收集音效（Web Audio 零外链合成）",
    sfxPreset: "coin",
  },
  {
    id: "sfx_dash",
    name: "冲刺音效 / Dash Whoosh SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "dash", "boost", "speed", "音效", "冲刺", "加速"],
    description: "高速冲刺锯齿波滑音（Web Audio 合成）",
    sfxPreset: "dash",
  },
  {
    id: "sfx_jump",
    name: "跳跃音效 / Jump SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "jump", "hop", "bounce", "音效", "跳跃", "弹跳"],
    description: "经典上扬跳跃音效（Web Audio 合成）",
    sfxPreset: "jump",
  },
  {
    id: "sfx_hit",
    name: "受击碰撞音效 / Hit Impact SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "hit", "damage", "collide", "impact", "音效", "碰撞", "受击", "打击"],
    description: "低沉方波碰撞打击音效（Web Audio 合成）",
    sfxPreset: "hit",
  },
  {
    id: "sfx_explosion",
    name: "爆炸音效 / Explosion SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "explosion", "boom", "destroy", "音效", "爆炸", "摧毁"],
    description: "低频轰鸣爆炸音效（Web Audio 合成）",
    sfxPreset: "explosion",
  },
  {
    id: "sfx_win",
    name: "胜利和弦音效 / Victory SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "win", "victory", "clear", "音效", "胜利", "通关"],
    description: "明快四音胜利琶音（Web Audio 合成）",
    sfxPreset: "win",
  },
  {
    id: "sfx_lose",
    name: "失败音效 / Game Over SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "lose", "gameover", "fail", "音效", "失败", "结束"],
    description: "下行失落结束音效（Web Audio 合成）",
    sfxPreset: "lose",
  },
  {
    id: "sfx_click",
    name: "界面点击音效 / UI Click SFX",
    kind: "procedural_sfx",
    source: "procedural",
    style: "arcade",
    tags: ["sfx", "sound", "click", "ui", "button", "音效", "点击", "按钮"],
    description: "轻快短促界面点击音（Web Audio 合成）",
    sfxPreset: "click",
  },
];

export function searchAssetCatalog(
  query: string,
  options?: { kind?: AssetEntry["kind"]; style?: CatalogAssetItem["style"]; limit?: number },
): CatalogAssetItem[] {
  const limit = Math.max(1, Math.min(30, options?.limit ?? 10));
  const tokens = query
    .toLowerCase()
    .split(/[\s,，、/+]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const filtered = CC0_ASSET_CATALOG.filter((item) => {
    if (options?.kind && item.kind !== options.kind) return false;
    if (options?.style && item.style !== options.style) return false;
    return true;
  });

  if (tokens.length === 0) {
    return filtered.slice(0, limit);
  }

  const scored = filtered
    .map((item) => {
      const haystack = `${item.id} ${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (item.tags.some((tag) => tag.toLowerCase() === tok)) score += 5;
        else if (item.id.toLowerCase().includes(tok)) score += 4;
        else if (haystack.includes(tok)) score += 2;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.item);
}

export function catalogItemToAssetEntry(item: CatalogAssetItem): AssetEntry {
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    url: item.url,
    sfxPreset: item.sfxPreset,
    width: item.width,
    height: item.height,
  };
}
