import { z } from "zod";
import { PlayerInputStateSchema, type GameConfigValues } from "./game.js";

export const RoomPlayerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  ready: z.boolean(),
  connected: z.boolean(),
});

export type RoomPlayerInfo = z.infer<typeof RoomPlayerInfoSchema>;

export const RoomPhaseSchema = z.enum(["lobby", "playing", "ended"]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const GameEventSchema = z.object({
  type: z.string(),
  payload: z.record(z.unknown()).optional(),
});
export type GameEvent = z.infer<typeof GameEventSchema>;

export const ClientRoomMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join"),
    playerName: z.string().min(1).max(24),
    playerId: z.string().optional(),
  }),
  z.object({
    type: z.literal("ready"),
    ready: z.boolean(),
  }),
  z.object({
    type: z.literal("start"),
  }),
  z.object({
    type: z.literal("restart"),
  }),
  z.object({
    type: z.literal("input"),
    input: PlayerInputStateSchema,
  }),
  z.object({
    type: z.literal("update_config"),
    config: z.record(z.union([z.number(), z.boolean(), z.string()])),
  }),
  z.object({
    type: z.literal("ping"),
    t: z.number(),
  }),
]);

export type ClientRoomMessage = z.infer<typeof ClientRoomMessageSchema>;

export interface ServerWelcomeMessage {
  type: "welcome";
  roomId: string;
  roomCode: string;
  playerId: string;
  hostPlayerId: string;
  players: RoomPlayerInfo[];
  phase: RoomPhase;
  tickRate: number;
  config: GameConfigValues;
  snapshot?: unknown;
}

export interface ServerRoomUpdateMessage {
  type: "room_update";
  roomId: string;
  roomCode: string;
  hostPlayerId: string;
  players: RoomPlayerInfo[];
  phase: RoomPhase;
  config: GameConfigValues;
}

export interface ServerSnapshotMessage {
  type: "snapshot";
  tick: number;
  serverTime: number;
  state: unknown;
  events: GameEvent[];
}

export interface ServerErrorMessage {
  type: "error";
  code: string;
  message: string;
  stack?: string;
}

export interface ServerPongMessage {
  type: "pong";
  t: number;
  serverTime: number;
}

export type ServerRoomMessage =
  | ServerWelcomeMessage
  | ServerRoomUpdateMessage
  | ServerSnapshotMessage
  | ServerErrorMessage
  | ServerPongMessage;

export interface CreateRoomRequest {
  gameId: string;
  title: string;
  simBundle: string;
  clientBundle?: string;
  spec: unknown;
  configSchema?: unknown;
  configValues: GameConfigValues;
  assets?: unknown;
  maxPlayers?: number;
  tickRate?: number;
  autoStart?: boolean;
}

export interface CreateRoomResponse {
  roomId: string;
  roomCode: string;
  wsPath: string;
  engine: "workerd";
}
