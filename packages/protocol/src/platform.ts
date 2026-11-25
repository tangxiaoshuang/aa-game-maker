import { z } from "zod";
import type { AssetEntry, AssetManifest, ConfigParam, GameConfigValues, GameSpec } from "./game.js";

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface SnapshotSummary {
  id: string;
  projectId: string;
  parentSnapshotId: string | null;
  commitSummary: string;
  fileCount: number;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  ownerId: string;
  forkedFromReleaseId: string | null;
  title: string;
  description: string;
  mode: "singleplayer" | "multiplayer";
  orientation: "portrait" | "landscape" | "responsive";
  currentSnapshotId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  files: Record<string, string>;
  configSchema: ConfigParam[];
  snapshots: SnapshotSummary[];
}

export interface ReleaseCard {
  id: string;
  slug: string;
  projectId: string;
  snapshotId: string;
  title: string;
  description: string;
  mode: "singleplayer" | "multiplayer";
  orientation: "portrait" | "landscape" | "responsive";
  authorId: string;
  authorName: string;
  coverUrl: string | null;
  playCount: number;
  likeCount: number;
  remixCount: number;
  likedByMe: boolean;
  isPublic: boolean;
  createdAt: string;
}

export interface ReleasePlayPayload {
  release: ReleaseCard;
  spec: GameSpec;
  configSchema: ConfigParam[];
  configValues: GameConfigValues;
  assets: AssetManifest;
  clientBundle: string;
  simBundle: string;
  clientBundleUrl?: string | null;
  roomBundleUrl?: string | null;
}

export const AuthCredentialsSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名仅支持字母、数字、下划线与短横线"),
  password: z.string().min(4).max(128),
  displayName: z.string().min(1).max(40).optional(),
});

export const CreateProjectRequestSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(400).default(""),
  templateId: z.string().optional(),
  files: z.record(z.string()).optional(),
  configSchema: z.array(z.unknown()).optional(),
});

export const SaveSnapshotRequestSchema = z.object({
  files: z.record(z.string()),
  commitSummary: z.string().min(1).max(200).default("手动保存快照"),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  configSchema: z.array(z.unknown()).optional(),
});

export const PublishReleaseRequestSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  isPublic: z.boolean().default(true),
  clientBundle: z.string().optional(),
  simBundle: z.string().optional(),
  coverDataUrl: z.string().optional(),
  files: z.record(z.string()).optional(),
  configSchema: z.array(z.unknown()).optional(),
});

export interface UploadAssetResponse {
  entry: AssetEntry;
  url: string;
  storage: "s3" | "inline";
}

export const GenerateAssetRequestSchema = z.object({
  prompt: z.string().min(1).max(300),
  assetId: z.string().min(1).max(60).optional(),
  style: z.enum(["neon", "pixel", "cartoon"]).default("neon"),
  removeBg: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
});
