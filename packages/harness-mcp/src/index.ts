import readline from "node:readline";
import type { RuntimeProbeResult } from "@aa-game/protocol";
import {
  DiskWorkspaceAdapter,
  GAME_DEV_SKILL_MD,
  HARNESS_TOOL_DEFINITIONS,
  HarnessToolExecutor,
} from "@aa-game/harness-core";

export interface HarnessMcpServerOptions {
  workspaceDir: string;
  roomServerUrl?: string;
  probeCallbackUrl?: string;
  probeSecret?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Standard Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio.
 * Exposes all @aa-game/harness-core tools and game://skill resources to any
 * local ACP/MCP coding agent (Claude Code, Gemini CLI, Codex, Goose, etc.).
 */
export function startHarnessMcpStdioServer(options: HarnessMcpServerOptions): void {
  const workspace = new DiskWorkspaceAdapter(options.workspaceDir);
  const executor = new HarnessToolExecutor(workspace, {
    roomServerUrl: options.roomServerUrl || process.env.AA_ROOM_SERVER_URL || "http://127.0.0.1:4000",
    requestWebProbe: options.probeCallbackUrl
      ? async () => {
          try {
            const res = await fetch(options.probeCallbackUrl!, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(options.probeSecret ? { "x-bridge-secret": options.probeSecret } : {}),
              },
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return null;
            return (await res.json()) as RuntimeProbeResult;
          } catch {
            return null;
          }
        }
      : undefined,
  });

  const send = (payload: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  };

  const handleRequest = async (req: JsonRpcRequest) => {
    const id = req.id;
    try {
      if (req.method === "initialize") {
        send({
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "aa-game-harness-mcp", version: "0.1.0" },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
          },
        });
        return;
      }

      if (req.method === "notifications/initialized" || req.method === "notifications/cancelled") {
        return;
      }

      if (req.method === "ping") {
        send({ id, result: {} });
        return;
      }

      if (req.method === "tools/list") {
        send({
          id,
          result: {
            tools: HARNESS_TOOL_DEFINITIONS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
        return;
      }

      if (req.method === "tools/call") {
        const params = req.params ?? {};
        const name = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = await executor.execute(name, args);
        send({
          id,
          result: {
            isError: !result.ok,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        });
        return;
      }

      if (req.method === "resources/list") {
        send({
          id,
          result: {
            resources: [
              {
                uri: "game://skill",
                name: "AA Game Maker Development Skill",
                mimeType: "text/markdown",
                description: "Architecture invariants for 2D singleplayer/multiplayer workerd games",
              },
              {
                uri: "game://spec",
                name: "Current Game Spec (spec.json)",
                mimeType: "application/json",
              },
              {
                uri: "game://assets",
                name: "Current Asset Manifest (assets.json)",
                mimeType: "application/json",
              },
            ],
          },
        });
        return;
      }

      if (req.method === "resources/read") {
        const uri = String(req.params?.uri ?? "");
        if (uri === "game://skill") {
          send({
            id,
            result: {
              contents: [{ uri, mimeType: "text/markdown", text: GAME_DEV_SKILL_MD }],
            },
          });
          return;
        }
        if (uri === "game://spec") {
          const text = (await workspace.readFile("spec.json")) ?? "{}";
          send({ id, result: { contents: [{ uri, mimeType: "application/json", text }] } });
          return;
        }
        if (uri === "game://assets") {
          const text = (await workspace.readFile("assets.json")) ?? '{"version":1,"assets":[]}';
          send({ id, result: { contents: [{ uri, mimeType: "application/json", text }] } });
          return;
        }
        send({ id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } });
        return;
      }

      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      }
    } catch (err) {
      if (id !== undefined) {
        send({
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      void handleRequest(req);
    } catch {
      // ignore malformed lines
    }
  });
}
