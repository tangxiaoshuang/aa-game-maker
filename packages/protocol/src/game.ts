import { z } from "zod";

export const ControlButtonSpecSchema = z.object({
  id: z.enum(["primary", "secondary"]),
  label: z.string().min(1).max(16),
  keyHint: z.string().min(1).max(16),
  color: z.string().optional(),
});

export const GameSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  description: z.string().max(400),
  mode: z.enum(["singleplayer", "multiplayer"]),
  orientation: z.enum(["portrait", "landscape", "responsive"]).default("responsive"),
  worldSize: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  maxPlayers: z.number().int().min(1).max(16).default(1),
  minPlayersToStart: z.number().int().min(1).max(16).default(1),
  tickRate: z.number().int().min(10).max(60).default(20),
  controls: z.object({
    joystick: z.boolean().default(true),
    pointer: z.boolean().default(false),
    buttons: z.array(ControlButtonSpecSchema).default([]),
  }),
  hudMode: z.enum(["platform", "custom", "hybrid"]).default("hybrid"),
});

export type ControlButtonSpec = z.infer<typeof ControlButtonSpecSchema>;
export type GameSpec = z.infer<typeof GameSpecSchema>;

export const ConfigParamSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["number", "boolean", "color", "select"]),
  defaultValue: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export type ConfigParam = z.infer<typeof ConfigParamSchema>;
export type GameConfigValues = Record<string, number | boolean | string>;

export const AssetEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["sprite", "audio_sfx", "audio_bgm", "procedural_sfx"]),
  source: z.enum(["cc0", "procedural", "uploaded", "generated"]),
  url: z.string().optional(),
  sfxPreset: z
    .enum(["jump", "coin", "hit", "dash", "explosion", "win", "lose", "click"])
    .optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(AssetEntrySchema),
});

export type AssetEntry = z.infer<typeof AssetEntrySchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export const PlayerInputStateSchema = z.object({
  moveX: z.number().min(-1).max(1).default(0),
  moveY: z.number().min(-1).max(1).default(0),
  aimX: z.number().optional(),
  aimY: z.number().optional(),
  primary: z.boolean().default(false),
  secondary: z.boolean().default(false),
  seq: z.number().int().nonnegative().default(0),
});

export type PlayerInputState = z.infer<typeof PlayerInputStateSchema>;
