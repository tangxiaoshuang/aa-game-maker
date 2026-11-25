import os from "node:os";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { Redis } from "ioredis";
import {
  ClientRoomMessageSchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type GameConfigValues,
} from "@aa-game/protocol";
import { WorkerdSandboxClient } from "./workerd-client.js";
import { RoomManager } from "./room-manager.js";

function detectLanIp(): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

export async function createRoomServerApp(options?: {
  port?: number;
  workerdPort?: number;
  redisUrl?: string;
}) {
  const workerd = new WorkerdSandboxClient(
    options?.workerdPort ?? Number(process.env.WORKERD_PORT || 4001),
  );
  await workerd.start();

  let redis: Redis | null = null;
  let redisConnected = false;
  const redisUrl = options?.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  try {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      lazyConnect: true,
    });
    redis.on("error", () => {});
    await redis.connect();
    await redis.ping();
    redisConnected = true;
  } catch {
    redis?.disconnect();
    redis = null;
    redisConnected = false;
  }

  const roomManager = new RoomManager(workerd, redis);
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    engine: "workerd",
    workerdHealthy: await workerd.isHealthy(),
    redisConnected,
    activeRooms: roomManager.getActiveRoomCount(),
    lanIp: detectLanIp(),
  }));

  app.get("/api/network-info", async () => ({
    lanIp: detectLanIp(),
    roomServerPort: options?.port ?? Number(process.env.ROOM_SERVER_PORT || 4000),
    playerPort: Number(process.env.PLAYER_PORT || 3001),
  }));

  app.post<{ Body: CreateRoomRequest }>("/api/rooms", async (request, reply) => {
    try {
      const body = request.body;
      if (!body?.simBundle) {
        return reply.status(400).send({ error: "simBundle is required" });
      }
      const room = await roomManager.createRoom(body);
      const response: CreateRoomResponse = {
        roomId: room.roomId,
        roomCode: room.roomCode,
        wsPath: `/ws/rooms/${room.roomId}`,
        engine: "workerd",
      };
      return response;
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get<{ Params: { key: string } }>("/api/rooms/:key", async (request, reply) => {
    const room = roomManager.getRoomByIdOrCode(request.params.key);
    if (!room) {
      return reply.status(404).send({ error: "Room not found" });
    }
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      gameId: room.gameId,
      title: room.title,
      phase: room.phase,
      players: Array.from(room.players.values()),
      spec: room.spec,
      configSchema: room.configSchema ?? [],
      configValues: room.configValues,
      assets: room.assets ?? { version: 1, assets: [] },
      clientBundle: room.clientBundle ?? "",
      simBundle: room.simBundle,
      wsPath: `/ws/rooms/${room.roomId}`,
    };
  });

  app.post<{
    Body: {
      simBundle: string;
      spec: { worldSize: { width: number; height: number }; tickRate: number; mode: string; maxPlayers: number };
      config: GameConfigValues;
      ticks?: number;
    };
  }>("/api/verify/smoke", async (request, reply) => {
    const body = request.body;
    if (!body?.simBundle) {
      return reply.status(400).send({ error: "simBundle is required" });
    }
    const result = await workerd.runSmokeTest(body);
    return result;
  });

  app.get<{ Params: { key: string } }>(
    "/ws/rooms/:key",
    { websocket: true },
    (socket, request) => {
      const room = roomManager.getRoomByIdOrCode(request.params.key);
      if (!room) {
        socket.send(
          JSON.stringify({ type: "error", code: "ROOM_NOT_FOUND", message: "房间不存在或已过期" }),
        );
        socket.close();
        return;
      }

      let boundPlayerId: string | null = null;

      socket.on("message", async (raw: Buffer) => {
        try {
          const parsed = ClientRoomMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
          if (!parsed.success) {
            socket.send(
              JSON.stringify({
                type: "error",
                code: "INVALID_MESSAGE",
                message: parsed.error.message,
              }),
            );
            return;
          }

          const msg = parsed.data;
          if (msg.type === "ping") {
            socket.send(JSON.stringify({ type: "pong", t: msg.t, serverTime: Date.now() }));
            return;
          }

          if (msg.type === "join") {
            if (boundPlayerId) return;
            const player = await roomManager.joinSocket(
              room,
              socket,
              msg.playerName,
              msg.playerId,
            );
            boundPlayerId = player.id;
            return;
          }

          if (!boundPlayerId) return;

          if (msg.type === "ready") {
            roomManager.setReady(room, boundPlayerId, msg.ready);
          } else if (msg.type === "start") {
            roomManager.startGame(room);
          } else if (msg.type === "pause") {
            roomManager.pauseGame(room);
          } else if (msg.type === "resume") {
            roomManager.resumeGame(room);
          } else if (msg.type === "restart") {
            await roomManager.restartGame(room);
          } else if (msg.type === "input") {
            roomManager.queueInput(room, boundPlayerId, msg.input);
          } else if (msg.type === "update_config") {
            await roomManager.updateConfig(room, msg.config);
          }
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "ROOM_HANDLER_ERROR",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });

      socket.on("close", () => {
        if (boundPlayerId) {
          void roomManager.handleDisconnect(room, boundPlayerId);
        }
      });
    },
  );

  app.addHook("onClose", async () => {
    await roomManager.shutdown();
    await workerd.stop();
    if (redis) redis.disconnect();
  });

  return { app, workerd, roomManager };
}

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  const port = Number(process.env.ROOM_SERVER_PORT || 4000);
  const { app } = await createRoomServerApp({ port });
  await app.listen({ port, host: "0.0.0.0" });
  console.log(
    `[room-server] Listening on http://0.0.0.0:${port} (workerd V8 isolate sandbox active, LAN IP: ${detectLanIp()})`,
  );
}
