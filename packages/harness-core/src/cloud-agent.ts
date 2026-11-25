import type { CloudAgentEvent, CloudAgentRequest } from "@aa-game/protocol";
import { buildHarnessUserPrompt, GAME_DEV_SKILL_MD } from "./skill.js";
import { HARNESS_TOOL_DEFINITIONS, HarnessToolExecutor, MemoryWorkspaceAdapter } from "./tools.js";

interface NormalizedTurnResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason: string;
}

async function callOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: unknown[],
): Promise<NormalizedTurnResponse> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const tools = HARNESS_TOOL_DEFINITIONS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          function?: { name: string; arguments: string };
        }>;
      };
    }>;
  };

  const choice = data.choices?.[0];
  const msg = choice?.message;
  const toolCalls = (msg?.tool_calls ?? []).map((tc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }
    return {
      id: tc.id || `tc_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.function?.name || "",
      args: parsedArgs,
    };
  });

  return {
    text: msg?.content || "",
    toolCalls,
    stopReason: choice?.finish_reason || "stop",
  };
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: unknown[],
): Promise<NormalizedTurnResponse> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const tools = HARNESS_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    stop_reason?: string;
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
  };

  let text = "";
  const toolCalls: NormalizedTurnResponse["toolCalls"] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }

  return {
    text,
    toolCalls,
    stopReason: data.stop_reason || "end_turn",
  };
}

/**
 * Built-in Cloud / BYOK Agent loop powered by the exact same @aa-game/harness-core
 * tools and Skill prompt that Local ACP Agents receive via MCP.
 */
export async function runCloudAgentLoop(
  req: CloudAgentRequest,
  emit: (event: CloudAgentEvent) => void,
): Promise<void> {
  const workspace = new MemoryWorkspaceAdapter(req.files);
  const executor = new HarnessToolExecutor(workspace, {
    roomServerUrl: req.roomServerUrl,
    onFileChanged: (filePath, content) => emit({ type: "file_update", path: filePath, content }),
    onSpecUpdated: (spec) => emit({ type: "spec_card", spec }),
    onVerifyCompleted: (report) => emit({ type: "verify_report", report }),
  });

  const userTask = buildHarnessUserPrompt({
    phase: req.phase,
    workflowMode: req.workflowMode,
    prompt: req.prompt,
    specJson: req.files["spec.json"],
    fileList: Object.keys(req.files).sort(),
  });

  emit({
    type: "phase",
    phase: req.phase,
    label:
      req.phase === "spec" && req.workflowMode === "spec-confirm"
        ? "生成轻量策划卡与资产清单..."
        : req.phase === "fix"
          ? "诊断并修复游戏报错..."
          : "AI 编码与 workerd 自检中...",
  });

  const maxTurns = req.phase === "spec" && req.workflowMode === "spec-confirm" ? 6 : 12;

  if (req.modelConfig.provider === "anthropic") {
    const messages: unknown[] = [
      ...req.history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userTask },
    ];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await callAnthropic(
        req.modelConfig.baseUrl || "https://api.anthropic.com",
        req.modelConfig.apiKey,
        req.modelConfig.model,
        GAME_DEV_SKILL_MD,
        messages,
      );

      if (response.text) emit({ type: "text_delta", text: response.text });
      if (response.toolCalls.length === 0) {
        emit({ type: "done", stopReason: response.stopReason });
        return;
      }

      const assistantBlocks: unknown[] = [];
      if (response.text) assistantBlocks.push({ type: "text", text: response.text });
      for (const tc of response.toolCalls) {
        assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      messages.push({ role: "assistant", content: assistantBlocks });

      const resultBlocks: unknown[] = [];
      for (const tc of response.toolCalls) {
        emit({ type: "tool_call", id: tc.id, name: tc.name, args: tc.args });
        const result = await executor.execute(tc.name, tc.args);
        emit({
          type: "tool_result",
          id: tc.id,
          name: tc.name,
          ok: result.ok,
          summary: result.summary,
          data: result.data,
        });
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
  } else {
    const messages: unknown[] = [
      { role: "system", content: GAME_DEV_SKILL_MD },
      ...req.history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userTask },
    ];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await callOpenAiCompatible(
        req.modelConfig.baseUrl || "https://api.openai.com/v1",
        req.modelConfig.apiKey,
        req.modelConfig.model,
        messages,
      );

      if (response.text) emit({ type: "text_delta", text: response.text });
      if (response.toolCalls.length === 0) {
        emit({ type: "done", stopReason: response.stopReason });
        return;
      }

      messages.push({
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const tc of response.toolCalls) {
        emit({ type: "tool_call", id: tc.id, name: tc.name, args: tc.args });
        const result = await executor.execute(tc.name, tc.args);
        emit({
          type: "tool_result",
          id: tc.id,
          name: tc.name,
          ok: result.ok,
          summary: result.summary,
          data: result.data,
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }
  }

  emit({ type: "done", stopReason: "max_turns_reached" });
}
