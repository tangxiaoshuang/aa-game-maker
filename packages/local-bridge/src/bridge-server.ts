import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { GAME_DEV_SKILL_MD } from "@aa-game/harness-core";
import type {
  AcpAgentDescriptor,
  BridgeClientMessage,
  BridgeServerMessage,
  RuntimeProbeResult,
} from "@aa-game/protocol";
import { AcpStdioClient } from "./acp-client.js";
import { LocalWorkspaceSync } from "./workspace-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

function resolveCommand(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
    if (out) return out;
  } catch {
    // fallback to common user binary paths
  }
  const extraPaths = [
    path.join(os.homedir(), ".local", "bin", cmd),
    path.join("/opt/homebrew/bin", cmd),
    path.join("/usr/local/bin", cmd),
  ];
  for (const p of extraPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveHarnessMcpCommand(): { command: string; baseArgs: string[] } {
  const builtCli = path.resolve(pkgRoot, "../harness-mcp/dist/cli.js");
  if (fs.existsSync(builtCli)) {
    return { command: process.execPath, baseArgs: [builtCli] };
  }
  const srcCli = path.resolve(pkgRoot, "../harness-mcp/src/cli.ts");
  const tsxBin = path.resolve(pkgRoot, "../../node_modules/.bin/tsx");
  return { command: tsxBin, baseArgs: [srcCli] };
}

function resolveDemoAcpCommand(): { command: string; args: string[] } {
  const builtDemo = path.resolve(pkgRoot, "dist/mock-acp-agent.js");
  if (fs.existsSync(builtDemo)) {
    return { command: process.execPath, args: [builtDemo] };
  }
  const srcDemo = path.resolve(pkgRoot, "src/mock-acp-agent.ts");
  const tsxBin = path.resolve(pkgRoot, "../../node_modules/.bin/tsx");
  return { command: tsxBin, args: [srcDemo] };
}

export function discoverLocalAcpAgents(): AcpAgentDescriptor[] {
  const demo = resolveDemoAcpCommand();
  const agyPath = resolveCommand("agy");
  const claudeAcpPath = resolveCommand("claude-code-acp");
  const geminiPath = resolveCommand("gemini");
  const goosePath = resolveCommand("goose");
  const codexAcpPath = resolveCommand("codex-acp");

  return [
    {
      id: "builtin-demo-acp",
      name: "Built-in Demo ACP Agent (验证完整 ACP+MCP+workerd)",
      command: demo.command,
      args: demo.args,
      available: true,
      description: "内置标准 ACP 示例 Agent，零模型费即可验证 MCP 注入、权限审批、文件双向同步与 workerd 自检",
    },
    {
      id: "antigravity-acp",
      name: "Antigravity CLI (agy acp)",
      command: agyPath ?? "agy",
      args: ["acp"],
      available: Boolean(agyPath),
      description: "通过本机 Antigravity CLI 原生 agy acp（Thin Editor 模式）接入",
    },
    {
      id: "claude-code-acp",
      name: "Claude Code (ACP Adapter)",
      command: claudeAcpPath ?? "claude-code-acp",
      args: [],
      available: Boolean(claudeAcpPath),
      description: "通过 Zed/社区 claude-code-acp 桥接本机 Claude Code",
    },
    {
      id: "gemini-cli-acp",
      name: "Gemini CLI (--acp)",
      command: geminiPath ?? "gemini",
      args: ["--acp"],
      available: Boolean(geminiPath),
      description: "通过本机 @google/gemini-cli 原生 --acp 模式接入",
    },
    {
      id: "goose-acp",
      name: "Goose (acp)",
      command: goosePath ?? "goose",
      args: ["acp"],
      available: Boolean(goosePath),
      description: "通过本机 Goose Agent ACP 模式接入",
    },
    {
      id: "codex-acp",
      name: "Codex CLI (codex-acp)",
      command: codexAcpPath ?? "codex-acp",
      args: [],
      available: Boolean(codexAcpPath),
      description: "通过本机 Codex ACP 适配器接入",
    },
  ];
}

export interface LocalBridgeOptions {
  port?: number;
  host?: string;
  token?: string;
  workspaceRoot?: string;
  roomServerUrl?: string;
  allowedOrigins?: string[];
}

export class LocalBridgeServer {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly workspaceRoot: string;
  readonly roomServerUrl: string;
  private readonly allowedOrigins: Set<string>;
  private readonly probeSecret: string;

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private workspaceSync: LocalWorkspaceSync | null = null;
  private acpClient: AcpStdioClient | null = null;
  private activeSessionId: string | null = null;
  private activeProjectId: string | null = null;
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly pendingProbes = new Map<string, (res: RuntimeProbeResult | null) => void>();

  constructor(options: LocalBridgeOptions = {}) {
    this.port = options.port ?? Number(process.env.AA_BRIDGE_PORT || 4318);
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token ?? crypto.randomBytes(6).toString("hex");
    this.workspaceRoot =
      options.workspaceRoot ?? path.join(os.homedir(), ".aa-game", "workspaces");
    this.roomServerUrl =
      options.roomServerUrl ?? process.env.ROOM_SERVER_URL ?? "http://127.0.0.1:4000";
    this.allowedOrigins = new Set(
      options.allowedOrigins ?? [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ],
    );
    this.probeSecret = crypto.randomBytes(12).toString("hex");
    fs.mkdirSync(this.workspaceRoot, { recursive: true });
  }

  private send(ws: WebSocket, msg: BridgeServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  async start(): Promise<{ port: number; url: string; token: string }> {
    this.httpServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            bridgeVersion: "0.1.0",
            workspaceRoot: this.workspaceRoot,
            connected: Boolean(this.activeSocket),
          }),
        );
        return;
      }

      // Internal callback invoked by our spawned harness-mcp subprocess during game_verify
      if (req.method === "POST" && req.url === "/internal/probe") {
        if (req.headers["x-bridge-secret"] !== this.probeSecret) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "Forbidden" }));
          return;
        }
        if (!this.activeSocket || this.activeSocket.readyState !== 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "Workbench not connected" }));
          return;
        }
        const probeId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const timer = setTimeout(() => {
          this.pendingProbes.delete(probeId);
          res.statusCode = 504;
          res.end(JSON.stringify({ error: "Web L3 probe timed out" }));
        }, 4000);

        this.pendingProbes.set(probeId, (result) => {
          clearTimeout(timer);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        });

        this.send(this.activeSocket, { type: "request_web_probe", probeId });
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    });

    this.wss = new WebSocketServer({
      noServer: true,
    });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const origin = req.headers.origin;
      // Strict Origin check prevents untrusted websites or isolated player iframe (:3001)
      // from connecting to the user's local ACP agent bridge.
      if (origin && !this.allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws) => {
      let authenticated = false;

      ws.on("message", async (raw) => {
        let msg: BridgeClientMessage;
        try {
          msg = JSON.parse(raw.toString("utf8")) as BridgeClientMessage;
        } catch {
          this.send(ws, { type: "error", message: "Invalid JSON message" });
          return;
        }

        if (!authenticated) {
          if (msg.type !== "auth" || msg.token !== this.token) {
            this.send(ws, { type: "auth_error", message: "配对 Token 无效，请核对终端显示的 Token" });
            ws.close(4001, "Unauthorized");
            return;
          }
          authenticated = true;
          this.activeSocket = ws;
          this.send(ws, {
            type: "auth_ok",
            bridgeVersion: "0.1.0",
            workspaceRoot: this.workspaceRoot,
            agents: discoverLocalAcpAgents(),
          });
          return;
        }

        await this.handleAuthenticatedMessage(ws, msg);
      });

      ws.on("close", () => {
        if (this.activeSocket === ws) {
          this.activeSocket = null;
          this.cleanupSession();
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, this.host, resolve);
    });

    const address = this.httpServer.address() as { port: number };
    const actualPort = address.port;
    return {
      port: actualPort,
      url: `ws://${this.host}:${actualPort}`,
      token: this.token,
    };
  }

  private async handleAuthenticatedMessage(ws: WebSocket, msg: BridgeClientMessage): Promise<void> {
    try {
      if (msg.type === "sync_project") {
        if (this.activeProjectId !== msg.projectId || !this.workspaceSync) {
          this.workspaceSync?.close();
          this.activeProjectId = msg.projectId;
          this.workspaceSync = new LocalWorkspaceSync({
            workspaceRoot: this.workspaceRoot,
            projectId: msg.projectId,
            onLocalChange: (relPath, content, revision) => {
              if (this.activeSocket) {
                this.send(this.activeSocket, {
                  type: "local_file_changed",
                  projectId: msg.projectId,
                  revision,
                  path: relPath,
                  content,
                });
              }
            },
          });
        }
        this.workspaceSync.syncFromWeb(msg.files, msg.revision);
        this.send(ws, {
          type: "project_synced",
          projectId: msg.projectId,
          workspaceDir: this.workspaceSync.workspaceDir,
          revision: this.workspaceSync.getRevision(),
        });
        return;
      }

      if (msg.type === "web_file_update") {
        this.workspaceSync?.writeFromWeb(msg.path, msg.content, msg.revision);
        return;
      }

      if (msg.type === "web_probe_result") {
        const resolver = this.pendingProbes.get(msg.probeId);
        if (resolver) {
          this.pendingProbes.delete(msg.probeId);
          resolver(msg.result);
        }
        return;
      }

      if (msg.type === "acp_permission_response") {
        const resolver = this.pendingPermissions.get(msg.requestId);
        if (resolver) {
          this.pendingPermissions.delete(msg.requestId);
          resolver(msg.optionId);
        }
        return;
      }

      if (msg.type === "acp_start_session") {
        if (!this.workspaceSync) {
          this.send(ws, { type: "error", message: "请先同步项目文件后再启动 ACP 会话" });
          return;
        }
        this.acpClient?.dispose();

        const discovered = discoverLocalAcpAgents();
        let command = msg.customCommand;
        let args = msg.customArgs ?? [];
        let agentName = msg.customCommand || msg.agentId;

        if (!command) {
          const match = discovered.find((a) => a.id === msg.agentId);
          if (!match) {
            this.send(ws, { type: "error", message: `未找到 Agent: ${msg.agentId}` });
            return;
          }
          command = match.command;
          args = match.args;
          agentName = match.name;
        }

        // Thin Editor compliance: write AGENTS.md as the single source of truth,
        // and thin @-import pointers for CLAUDE.md and GEMINI.md to avoid duplicating content.
        fs.writeFileSync(
          path.join(this.workspaceSync.workspaceDir, "AGENTS.md"),
          GAME_DEV_SKILL_MD,
          "utf8",
        );
        fs.writeFileSync(
          path.join(this.workspaceSync.workspaceDir, "CLAUDE.md"),
          "@AGENTS.md\n",
          "utf8",
        );
        fs.writeFileSync(
          path.join(this.workspaceSync.workspaceDir, "GEMINI.md"),
          "@./AGENTS.md\n",
          "utf8",
        );

        const actualPort = (this.httpServer!.address() as { port: number }).port;
        const mcpCmd = resolveHarnessMcpCommand();
        const mcpServerConfig = {
          name: "aa-game-harness",
          command: mcpCmd.command,
          args: [
            ...mcpCmd.baseArgs,
            "--workspace",
            this.workspaceSync.workspaceDir,
            "--room-server",
            this.roomServerUrl,
            "--probe-url",
            `http://${this.host}:${actualPort}/internal/probe`,
            "--probe-secret",
            this.probeSecret,
          ],
          env: [] as Array<{ name: string; value: string }>,
        };

        this.acpClient = new AcpStdioClient(this.workspaceSync.workspaceDir, {
          onUpdate: (sessionId, update) => {
            this.send(ws, { type: "acp_update", sessionId, update });
          },
          onPermissionRequest: (request) => {
            return new Promise<string | null>((resolve) => {
              this.pendingPermissions.set(request.requestId, resolve);
              this.send(ws, { type: "acp_permission_request", request });
            });
          },
          onStderr: (text) => {
            if (text.trim()) {
              process.stderr.write(`[acp:${msg.agentId}] ${text}`);
            }
          },
        });

        const { sessionId } = await this.acpClient.connect(command, args, [mcpServerConfig]);
        this.activeSessionId = sessionId;
        this.send(ws, {
          type: "acp_session_started",
          sessionId,
          agentId: msg.agentId,
          agentName,
          mcpServerInjected: true,
        });
        return;
      }

      if (msg.type === "acp_prompt") {
        if (!this.acpClient || !this.activeSessionId || !this.workspaceSync) {
          this.send(ws, { type: "error", message: "尚未建立活跃的 ACP 会话" });
          return;
        }
        // Thin Editor passthrough: forward the human user's raw prompt verbatim to the
        // local ACP agent. Project rules are provided via workspace AGENTS.md/GEMINI.md
        // and optional tools via the standard MCP server.
        const res = await this.acpClient.prompt(msg.prompt);
        this.workspaceSync.flushDiskChanges();
        this.send(ws, {
          type: "acp_prompt_done",
          sessionId: this.activeSessionId,
          stopReason: res.stopReason,
        });
        return;
      }

      if (msg.type === "acp_cancel") {
        this.acpClient?.cancel();
      }
    } catch (err) {
      this.send(ws, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private cleanupSession(): void {
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    this.pendingPermissions.clear();
    for (const resolve of this.pendingProbes.values()) resolve(null);
    this.pendingProbes.clear();
    this.acpClient?.dispose();
    this.acpClient = null;
    this.activeSessionId = null;
    this.workspaceSync?.close();
    this.workspaceSync = null;
  }

  async stop(): Promise<void> {
    this.cleanupSession();
    this.wss?.close();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }
}
