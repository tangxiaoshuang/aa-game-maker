import { z } from "zod";
import type { FullVerifyReport, GameConfigValues, GameSpec, RuntimeProbeResult } from "./index.js";

export const AgentModeSchema = z.enum(["local-acp", "cloud-byok"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const CreationWorkflowModeSchema = z.enum(["spec-confirm", "fast-direct"]);
export type CreationWorkflowMode = z.infer<typeof CreationWorkflowModeSchema>;

export const CloudProviderSchema = z.enum(["openai-compatible", "anthropic"]);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

export interface CloudModelConfig {
  provider: CloudProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thought?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args?: Record<string, unknown>;
    status: "running" | "done" | "error";
    resultSummary?: string;
  }>;
  specCard?: {
    spec: GameSpec;
    confirmed: boolean;
  };
  verifyReport?: FullVerifyReport;
  timestamp: number;
}

/**
 * Standard Agent Client Protocol (ACP) JSON-RPC subset used between
 * Local Bridge (ACP Client) and User Local Agents (ACP Server over stdio).
 */
export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface AcpAgentDescriptor {
  id: string;
  name: string;
  command: string;
  args: string[];
  available: boolean;
  description: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpPermissionRequest {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  title: string;
  description?: string;
  options: AcpPermissionOption[];
}

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
  | { sessionUpdate: "agent_thought_chunk"; content: { type: "text"; text: string } }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      rawInput?: Record<string, unknown>;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "plan";
      entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
    };

/**
 * Web Workbench <-> Local Bridge WebSocket protocol (ws://127.0.0.1:4318).
 */
export type BridgeClientMessage =
  | {
      type: "auth";
      token: string;
    }
  | {
      type: "sync_project";
      projectId: string;
      revision: number;
      files: Record<string, string>;
    }
  | {
      type: "web_file_update";
      projectId: string;
      revision: number;
      path: string;
      content: string;
    }
  | {
      type: "acp_start_session";
      projectId: string;
      agentId: string;
      customCommand?: string;
      customArgs?: string[];
    }
  | {
      type: "acp_prompt";
      sessionId: string;
      prompt: string;
      workflowMode: CreationWorkflowMode;
      phase: "spec" | "implement" | "iterate" | "fix";
    }
  | {
      type: "acp_cancel";
      sessionId: string;
    }
  | {
      type: "acp_permission_response";
      requestId: string;
      optionId: string | null;
    }
  | {
      type: "web_probe_result";
      probeId: string;
      result: RuntimeProbeResult;
    };

export type BridgeServerMessage =
  | {
      type: "auth_ok";
      bridgeVersion: string;
      workspaceRoot: string;
      agents: AcpAgentDescriptor[];
    }
  | {
      type: "auth_error";
      message: string;
    }
  | {
      type: "project_synced";
      projectId: string;
      workspaceDir: string;
      revision: number;
    }
  | {
      type: "local_file_changed";
      projectId: string;
      revision: number;
      path: string;
      content: string;
    }
  | {
      type: "acp_session_started";
      sessionId: string;
      agentId: string;
      agentName: string;
      mcpServerInjected: boolean;
    }
  | {
      type: "acp_update";
      sessionId: string;
      update: AcpSessionUpdate;
    }
  | {
      type: "acp_permission_request";
      request: AcpPermissionRequest;
    }
  | {
      type: "acp_prompt_done";
      sessionId: string;
      stopReason: string;
    }
  | {
      type: "request_web_probe";
      probeId: string;
    }
  | {
      type: "error";
      message: string;
    };

/**
 * Cloud / BYOK Agent streaming events (NDJSON from /api/agent).
 */
export interface CloudAgentRequest {
  workflowMode: CreationWorkflowMode;
  phase: "spec" | "implement" | "iterate" | "fix";
  prompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  files: Record<string, string>;
  configValues: GameConfigValues;
  modelConfig: CloudModelConfig;
  roomServerUrl?: string;
}

export type CloudAgentEvent =
  | { type: "phase"; phase: string; label: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; data?: unknown }
  | { type: "spec_card"; spec: GameSpec }
  | { type: "file_update"; path: string; content: string }
  | { type: "verify_report"; report: FullVerifyReport }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
