import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type {
  CreateRoomRequest,
  GameConfigValues,
  PlayerInputState,
  RoomPhase,
  RoomPlayerInfo,
  ServerRoomMessage,
} from "@aa-game/protocol";
import type { Redis } from "ioredis";
import type { WorkerdSandboxClient } from "./workerd-client.js";

const PLAYER_COLORS = ["#38bdf8", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185"];

interface ConnectedClient {
  socket: WebSocket;
  playerId: string;
}

export interface ManagedRoom {
  roomId: string;
  roomCode: string;
  gameId: string;
  title: string;
  simBundle: string;
  clientBundle?: string;
  spec: {
    worldSize: { width: number; height: number };
    tickRate: number;
    maxPlayers: number;
    [key: string]: unknown;
  };
  configSchema?: unknown;
  configValues: GameConfigValues;
  assets?: unknown;
  phase: RoomPhase;
  hostPlayerId: string;
  version: number;
  players: Map<string, RoomPlayerInfo>;
  clients: Map<string, ConnectedClient>;
  pendingInputs: Map<string, PlayerInputState>;
  lastSnapshot: unknown;
  tickTimer: NodeJS.Timeout | null;
  ticking: boolean;
  consecutiveErrors: number;
  autoStart: boolean;
  createdAt: number;
}

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, ManagedRoom>();
  private readonly codeToId = new Map<string, string>();
  private readonly workerd: WorkerdSandboxClient;
  private readonly redis: Redis | null;

  constructor(workerd: WorkerdSandboxClient, redis: Redis | null) {
    this.workerd = workerd;
    this.redis = redis;
  }

  getActiveRoomCount(): number {
    return this.rooms.size;
  }

  getRoomByIdOrCode(key: string): ManagedRoom | undefined {
    const direct = this.rooms.get(key);
    if (direct) return direct;
    const byCode = this.codeToId.get(key.toUpperCase());
    return byCode ? this.rooms.get(byCode) : undefined;
  }

  async createRoom(req: CreateRoomRequest): Promise<ManagedRoom> {
    const roomId = crypto.randomUUID().slice(0, 12);
    let roomCode = generateRoomCode();
    while (this.codeToId.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const specObj = (req.spec || {}) as ManagedRoom["spec"];
    const worldSize = specObj.worldSize ?? { width: 900, height: 560 };
    const tickRate = Math.max(10, Math.min(60, req.tickRate ?? specObj.tickRate ?? 20));
    const maxPlayers = Math.max(1, Math.min(16, req.maxPlayers ?? specObj.maxPlayers ?? 4));

    const initRes = await this.workerd.initRoom({
      roomId,
      version: 1,
      simBundle: req.simBundle,
      worldSize,
      tickRate,
      config: req.configValues,
      seed: Date.now() & 0x7fffffff,
    });

    if (!initRes.ok) {
      throw new Error(initRes.error || "workerd failed to initialize room simulation");
    }

    const room: ManagedRoom = {
      roomId,
      roomCode,
      gameId: req.gameId,
      title: req.title,
      simBundle: req.simBundle,
      clientBundle: req.clientBundle,
      spec: { ...specObj, worldSize, tickRate, maxPlayers },
      configSchema: req.configSchema,
      configValues: { ...req.configValues },
      assets: req.assets,
      phase: req.autoStart ? "playing" : "lobby",
      hostPlayerId: "",
      version: 1,
      players: new Map(),
      clients: new Map(),
      pendingInputs: new Map(),
      lastSnapshot: initRes.state,
      tickTimer: null,
      ticking: false,
      consecutiveErrors: 0,
      autoStart: Boolean(req.autoStart),
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    this.codeToId.set(roomCode, roomId);
    await this.syncRoomMetaToRedis(room);

    if (room.phase === "playing") {
      this.startTickLoop(room);
    }

    return room;
  }

  private async syncRoomMetaToRedis(room: ManagedRoom): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(
        `room:meta:${room.roomId}`,
        JSON.stringify({
          roomId: room.roomId,
          roomCode: room.roomCode,
          gameId: room.gameId,
          title: room.title,
          phase: room.phase,
          playersCount: room.players.size,
          updatedAt: Date.now(),
        }),
        "EX",
        3600,
      );
    } catch {
      // Redis metadata sync is best-effort in dev
    }
  }

  private send(socket: WebSocket, msg: ServerRoomMessage): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
    }
  }

  private broadcast(room: ManagedRoom, msg: ServerRoomMessage): void {
    const raw = JSON.stringify(msg);
    for (const client of room.clients.values()) {
      if (client.socket.readyState === 1) {
        client.socket.send(raw);
      }
    }
  }

  private broadcastRoomUpdate(room: ManagedRoom): void {
    this.broadcast(room, {
      type: "room_update",
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostPlayerId: room.hostPlayerId,
      players: Array.from(room.players.values()),
      phase: room.phase,
      config: room.configValues,
    });
    void this.syncRoomMetaToRedis(room);
  }

  async joinSocket(
    room: ManagedRoom,
    socket: WebSocket,
    playerName: string,
    requestedPlayerId?: string,
  ): Promise<RoomPlayerInfo> {
    if (room.players.size >= room.spec.maxPlayers) {
      throw new Error(`房间已满（最多 ${room.spec.maxPlayers} 人）`);
    }

    const playerId = requestedPlayerId || `p_${crypto.randomUUID().slice(0, 8)}`;
    const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length]!;
    const player: RoomPlayerInfo = {
      id: playerId,
      name: playerName.trim().slice(0, 24) || `Player ${room.players.size + 1}`,
      color,
      ready: room.autoStart,
      connected: true,
    };

    room.players.set(playerId, player);
    room.clients.set(playerId, { socket, playerId });
    if (!room.hostPlayerId) {
      room.hostPlayerId = playerId;
    }

    const joinRes = await this.workerd.joinPlayer(room.roomId, {
      id: player.id,
      name: player.name,
      color: player.color,
    });
    if (!joinRes.ok) {
      room.players.delete(playerId);
      room.clients.delete(playerId);
      throw new Error(joinRes.error || "workerd join failed");
    }
    room.lastSnapshot = joinRes.state;

    this.send(socket, {
      type: "welcome",
      roomId: room.roomId,
      roomCode: room.roomCode,
      playerId: player.id,
      hostPlayerId: room.hostPlayerId,
      players: Array.from(room.players.values()),
      phase: room.phase,
      tickRate: room.spec.tickRate,
      config: room.configValues,
      snapshot: room.lastSnapshot,
    });

    this.broadcastRoomUpdate(room);
    return player;
  }

  async handleDisconnect(room: ManagedRoom, playerId: string): Promise<void> {
    room.clients.delete(playerId);
    room.players.delete(playerId);
    room.pendingInputs.delete(playerId);

    await this.workerd.leavePlayer(room.roomId, playerId).catch(() => {});

    if (room.hostPlayerId === playerId) {
      const nextHost = room.players.keys().next().value;
      room.hostPlayerId = nextHost ?? "";
    }

    if (room.clients.size === 0) {
      this.stopTickLoop(room);
      // Keep room alive for 5 minutes so refreshed tabs or QR scans can still join
    } else {
      this.broadcastRoomUpdate(room);
    }
  }

  setReady(room: ManagedRoom, playerId: string, ready: boolean): void {
    const p = room.players.get(playerId);
    if (!p) return;
    p.ready = ready;
    this.broadcastRoomUpdate(room);
  }

  startGame(room: ManagedRoom): void {
    room.phase = "playing";
    this.startTickLoop(room);
    this.broadcastRoomUpdate(room);
  }

  async restartGame(room: ManagedRoom): Promise<void> {
    this.stopTickLoop(room);
    room.version += 1;
    const initRes = await this.workerd.initRoom({
      roomId: room.roomId,
      version: room.version,
      simBundle: room.simBundle,
      worldSize: room.spec.worldSize,
      tickRate: room.spec.tickRate,
      config: room.configValues,
      seed: Date.now() & 0x7fffffff,
    });
    if (!initRes.ok) {
      this.broadcast(room, {
        type: "error",
        code: "RESTART_FAILED",
        message: initRes.error || "Failed to restart workerd isolate",
        stack: initRes.stack,
      });
      return;
    }

    for (const p of room.players.values()) {
      const jr = await this.workerd.joinPlayer(room.roomId, {
        id: p.id,
        name: p.name,
        color: p.color,
      });
      if (jr.ok) room.lastSnapshot = jr.state;
    }

    room.phase = "playing";
    this.startTickLoop(room);
    this.broadcastRoomUpdate(room);
  }

  queueInput(room: ManagedRoom, playerId: string, input: PlayerInputState): void {
    room.pendingInputs.set(playerId, input);
  }

  async updateConfig(room: ManagedRoom, config: GameConfigValues): Promise<void> {
    room.configValues = { ...room.configValues, ...config };
    await this.workerd.updateConfig(room.roomId, room.configValues);
    this.broadcastRoomUpdate(room);
  }

  private startTickLoop(room: ManagedRoom): void {
    if (room.tickTimer) return;
    const intervalMs = Math.round(1000 / room.spec.tickRate);
    room.tickTimer = setInterval(() => {
      void this.executeTick(room);
    }, intervalMs);
  }

  private stopTickLoop(room: ManagedRoom): void {
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
    }
  }

  private async executeTick(room: ManagedRoom): Promise<void> {
    if (room.ticking || room.clients.size === 0) return;
    room.ticking = true;
    try {
      const inputs: Array<{ playerId: string; input: PlayerInputState }> = [];
      for (const [playerId, input] of room.pendingInputs.entries()) {
        inputs.push({ playerId, input });
      }

      const res = await this.workerd.tickRoom(room.roomId, inputs);
      if (!res.ok) {
        room.consecutiveErrors += 1;
        this.broadcast(room, {
          type: "error",
          code: "SIM_TICK_ERROR",
          message: res.error || "Simulation tick failed in workerd isolate",
          stack: res.stack,
        });
        if (room.consecutiveErrors >= 3) {
          this.stopTickLoop(room);
        }
        return;
      }

      room.consecutiveErrors = 0;
      room.lastSnapshot = res.state;
      this.broadcast(room, {
        type: "snapshot",
        tick: res.tick ?? 0,
        serverTime: Date.now(),
        state: res.state,
        events: res.events ?? [],
      });
    } catch (err) {
      room.consecutiveErrors += 1;
      if (room.consecutiveErrors >= 5) {
        this.stopTickLoop(room);
      }
      this.broadcast(room, {
        type: "error",
        code: "ISOLATE_TIMEOUT",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      room.ticking = false;
    }
  }

  async shutdown(): Promise<void> {
    for (const room of this.rooms.values()) {
      this.stopTickLoop(room);
      await this.workerd.destroyRoom(room.roomId);
    }
    this.rooms.clear();
    this.codeToId.clear();
  }
}
