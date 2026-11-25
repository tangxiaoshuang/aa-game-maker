import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  AcpMcpServerConfig,
  AcpPermissionRequest,
  AcpSessionUpdate,
} from "@aa-game/protocol";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpClientCallbacks {
  onUpdate: (sessionId: string, update: AcpSessionUpdate) => void;
  onPermissionRequest: (req: AcpPermissionRequest) => Promise<string | null>;
  onStderr?: (text: string) => void;
}

/**
 * Standard Agent Client Protocol (ACP) JSON-RPC 2.0 client over stdio.
 * Connects to any local ACP-compliant agent (Claude Code ACP, Gemini CLI ACP,
 * Codex ACP, Goose ACP, or the built-in demo ACP agent), automatically injects
 * the platform Game Harness MCP Server, and proxies permission requests back to
 * the Web Workbench UI.
 */
export class AcpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly workspaceDir: string;
  private readonly callbacks: AcpClientCallbacks;
  private sessionId: string | null = null;

  constructor(workspaceDir: string, callbacks: AcpClientCallbacks) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.callbacks = callbacks;
  }

  async connect(
    command: string,
    args: string[],
    mcpServers: AcpMcpServerConfig[],
  ): Promise<{ sessionId: string }> {
    this.proc = spawn(command, args, {
      cwd: this.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.callbacks.onStderr?.(chunk.toString("utf8"));
    });

    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`ACP agent process exited (code=${code})`));
      }
      this.pending.clear();
    });

    const rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        void this.handleMessage(msg);
      } catch {
        // ignore non-JSON debug lines
      }
    });

    const initRes = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: {
        name: "aa-game-maker-bridge",
        version: "0.1.0",
      },
    })) as { authMethods?: Array<{ id: string; name?: string }> };

    // Thin Editor compliance: NEVER silently auto-select consumer OAuth (`oauth-personal`).
    // Only invoke `authenticate` automatically when an explicit developer billing env var
    // (GEMINI_API_KEY or Vertex AI) is configured; otherwise let the agent manage its own auth.
    const authMethods = Array.isArray(initRes?.authMethods) ? initRes.authMethods : [];
    if (authMethods.length > 0) {
      const explicitDevMethod = process.env.GEMINI_API_KEY
        ? authMethods.find((m) => m.id === "gemini-api-key")
        : process.env.GOOGLE_GENAI_USE_VERTEXAI
          ? authMethods.find((m) => m.id === "vertex-ai")
          : undefined;

      if (explicitDevMethod?.id) {
        try {
          await this.request("authenticate", { methodId: explicitDevMethod.id });
        } catch (err) {
          this.callbacks.onStderr?.(
            `ACP authenticate(${explicitDevMethod.id}) warning: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      } else {
        this.callbacks.onStderr?.(
          `[acp-thin-editor] No explicit GEMINI_API_KEY / Vertex AI env detected; relying on agent native auth. For external clients, developer API billing (GEMINI_API_KEY / Vertex AI) is recommended.\n`,
        );
      }
    }

    const sessionRes = (await this.request("session/new", {
      cwd: this.workspaceDir,
      mcpServers,
    })) as { sessionId?: string };

    if (!sessionRes?.sessionId) {
      throw new Error("ACP agent did not return a sessionId from session/new");
    }
    this.sessionId = sessionRes.sessionId;
    return { sessionId: this.sessionId };
  }

  async prompt(promptText: string): Promise<{ stopReason: string }> {
    if (!this.sessionId) throw new Error("ACP session not initialized");
    const res = (await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: promptText }],
    })) as { stopReason?: string };
    return { stopReason: res?.stopReason || "end_turn" };
  }

  cancel(): void {
    if (!this.sessionId) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  dispose(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.sessionId = null;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("ACP agent stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return;
    this.sendRaw({ method, params });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendRaw({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    // Response to our outbound request
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) {
        pending.reject(new Error(`ACP error (${msg.error.code}): ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Inbound notification from Agent
    if (msg.method === "session/update" && msg.params) {
      const sid = String(msg.params.sessionId ?? this.sessionId ?? "");
      const update = msg.params.update as AcpSessionUpdate | undefined;
      if (update) {
        this.callbacks.onUpdate(sid, update);
      }
      return;
    }

    // Inbound Agent -> Client JSON-RPC requests
    if (msg.id !== undefined && msg.method) {
      try {
        if (msg.method === "session/request_permission") {
          const params = msg.params ?? {};
          const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
          const options = (Array.isArray(params.options) ? params.options : []) as AcpPermissionRequest["options"];
          const reqId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const selectedOptionId = await this.callbacks.onPermissionRequest({
            requestId: reqId,
            sessionId: String(params.sessionId ?? this.sessionId ?? ""),
            toolCallId: toolCall.toolCallId ? String(toolCall.toolCallId) : undefined,
            title: String(toolCall.title ?? "允许 Agent 执行操作"),
            description: toolCall.description ? String(toolCall.description) : undefined,
            options,
          });
          this.sendRaw({
            id: msg.id,
            result: selectedOptionId
              ? { outcome: { outcome: "selected", optionId: selectedOptionId } }
              : { outcome: { outcome: "cancelled" } },
          });
          return;
        }

        if (msg.method === "fs/read_text_file") {
          const target = this.resolveWorkspaceFile(String(msg.params?.path ?? ""));
          const content = fs.readFileSync(target, "utf8");
          this.sendRaw({ id: msg.id, result: { content } });
          return;
        }

        if (msg.method === "fs/write_text_file") {
          const target = this.resolveWorkspaceFile(String(msg.params?.path ?? ""));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(msg.params?.content ?? ""), "utf8");
          this.sendRaw({ id: msg.id, result: {} });
          return;
        }

        this.sendRaw({
          id: msg.id,
          error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
        });
      } catch (err) {
        this.sendRaw({
          id: msg.id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  private resolveWorkspaceFile(filePath: string): string {
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.workspaceDir, filePath);
    if (abs !== this.workspaceDir && !abs.startsWith(this.workspaceDir + path.sep)) {
      throw new Error(`ACP file access outside workspace denied: ${filePath}`);
    }
    return abs;
  }
}
