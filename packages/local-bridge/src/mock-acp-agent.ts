/**
 * Built-in ACP-compliant Demo / E2E Test Agent.
 * Implements real ACP JSON-RPC over stdio AND spawns the injected
 * `aa-game-harness` MCP Server to invoke real harness tools
 * (game_search_assets, game_register_asset, game_update_config, game_verify).
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

interface RpcMsg {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class SimpleMcpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(command: string, args: string[], cwd: string) {
    this.proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const rl = readline.createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const msg = JSON.parse(t) as RpcMsg;
        if (msg.id !== undefined) {
          const p = this.pending.get(Number(msg.id));
          if (p) {
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        }
      } catch {
        // ignore
      }
    });
  }

  async initialize(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "demo-acp-agent", version: "0.1.0" },
      capabilities: {},
    });
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.proc.kill("SIGTERM");
  }
}

let mcpClient: SimpleMcpClient | null = null;
let sessionId = "acp_demo_session_1";
let clientReqId = 1000;
const clientPending = new Map<number, (result: unknown) => void>();

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

function sendUpdate(update: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update } });
}

function requestClient(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = clientReqId++;
  return new Promise((resolve) => {
    clientPending.set(id, resolve);
    send({ id, method, params });
  });
}

async function handlePrompt(promptText: string): Promise<string> {
  sendUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: {
      type: "text",
      text: `Thin Editor 透传收到原始指令(${promptText.length}字): ${promptText.slice(0, 80)}`,
    },
  });

  if (!mcpClient) {
    sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "未检测到注入的 Game Harness MCP Server，请检查 Bridge 配置。" },
    });
    return "end_turn";
  }

  // 1. Ask user permission via ACP protocol before modifying project files
  const permRes = (await requestClient("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "tc_perm_1",
      title: "允许本地 ACP Agent 检索 CC0 素材并更新配置与运行 workerd 自检",
      description: `将调用 aa-game-harness MCP 修改当前项目并执行 L1~L3 校验`,
    },
    options: [
      { optionId: "allow_once", name: "允许本次", kind: "allow_once" },
      { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
    ],
  })) as { outcome?: { outcome?: string; optionId?: string } };

  if (permRes?.outcome?.outcome !== "selected" || permRes?.outcome?.optionId === "reject_once") {
    sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "已根据你的选择取消本次操作。" },
    });
    return "cancelled";
  }

  // 2. Search CC0 assets via real MCP Server
  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_assets",
    title: "MCP: game_search_assets",
    status: "in_progress",
    rawInput: { query: promptText || "star ship" },
  });
  const searchRes = await mcpClient.call("tools/call", {
    name: "game_search_assets",
    arguments: { query: promptText.includes("史莱姆") ? "史莱姆" : "star shield", limit: 3 },
  });
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_assets",
    status: "completed",
    rawOutput: searchRes,
  });

  // 3. Register a CC0 asset & tune speed config via MCP
  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_reg",
    title: "MCP: game_register_asset",
    status: "in_progress",
    rawInput: { catalogId: "cc0_shield_orb" },
  });
  const regRes = await mcpClient.call("tools/call", {
    name: "game_register_asset",
    arguments: { catalogId: "cc0_shield_orb" },
  });
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_reg",
    status: "completed",
    rawOutput: regRes,
  });

  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_cfg",
    title: "MCP: game_update_config",
    status: "in_progress",
    rawInput: { values: { playerSpeed: 360, moveSpeed: 310 } },
  });
  const cfgRes = await mcpClient.call("tools/call", {
    name: "game_update_config",
    arguments: { values: { playerSpeed: 360, moveSpeed: 310 } },
  });
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_cfg",
    status: "completed",
    rawOutput: cfgRes,
  });

  // 4. Invoke real game_verify (L1 esbuild + L2 workerd isolate + L3 browser probe callback!)
  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_verify",
    title: "MCP: game_verify (L1 + workerd L2 + L3)",
    status: "in_progress",
    rawInput: { ticks: 60 },
  });
  const verifyRes = (await mcpClient.call("tools/call", {
    name: "game_verify",
    arguments: { ticks: 60 },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_verify",
    status: verifyRes?.isError ? "failed" : "completed",
    rawOutput: verifyRes,
  });

  const verifySummary = (() => {
    try {
      const parsed = JSON.parse(verifyRes.content?.[0]?.text || "{}") as { summary?: string };
      return parsed.summary || "校验完成";
    } catch {
      return "校验完成";
    }
  })();

  sendUpdate({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `✅ 已通过本地 ACP Agent + 注入的 Game Harness MCP 完成全链路执行：\n- 已检索并注册 CC0 护盾资产 (\`cc0_shield_orb\`) 到 \`assets.json\`\n- 已热更新移动速度参数到 \`config.json\` 并双向同步回 Web 工作台\n- 自检结果：${verifySummary}`,
    },
  });

  return "end_turn";
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMsg;
  try {
    msg = JSON.parse(trimmed) as RpcMsg;
  } catch {
    return;
  }

  if (msg.id !== undefined && !msg.method) {
    const resolver = clientPending.get(Number(msg.id));
    if (resolver) {
      clientPending.delete(Number(msg.id));
      resolver(msg.result);
    }
    return;
  }

  try {
    if (msg.method === "initialize") {
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "aa-demo-acp-agent", version: "0.1.0" },
          agentCapabilities: { loadSession: false },
        },
      });
      return;
    }

    if (msg.method === "session/new") {
      const params = msg.params ?? {};
      const cwd = String(params.cwd || process.cwd());
      const mcpServers = (Array.isArray(params.mcpServers) ? params.mcpServers : []) as Array<{
        name: string;
        command: string;
        args: string[];
      }>;
      const harnessServer = mcpServers.find((s) => s.name === "aa-game-harness");
      if (harnessServer) {
        mcpClient?.close();
        mcpClient = new SimpleMcpClient(harnessServer.command, harnessServer.args, cwd);
        await mcpClient.initialize();
      }
      sessionId = `acp_demo_${Date.now()}`;
      send({ id: msg.id, result: { sessionId } });
      return;
    }

    if (msg.method === "session/prompt") {
      const promptBlocks = (msg.params?.prompt as Array<{ text?: string }>) ?? [];
      const text = promptBlocks.map((b) => b.text || "").join("\n");
      const stopReason = await handlePrompt(text);
      send({ id: msg.id, result: { stopReason } });
      return;
    }

    if (msg.method === "session/cancel") {
      return;
    }

    if (msg.id !== undefined) {
      send({ id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } });
    }
  } catch (err) {
    if (msg.id !== undefined) {
      send({
        id: msg.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
});

process.on("SIGTERM", () => {
  mcpClient?.close();
  process.exit(0);
});
