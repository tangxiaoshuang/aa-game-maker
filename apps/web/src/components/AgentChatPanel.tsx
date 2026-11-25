"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  AcpAgentDescriptor,
  AcpPermissionRequest,
  AgentChatMessage,
  AgentMode,
  BridgeClientMessage,
  BridgeServerMessage,
  CloudAgentEvent,
  CloudModelConfig,
  CreationWorkflowMode,
  FullVerifyReport,
  GameConfigValues,
  GameSpec,
  RuntimeProbeResult,
} from "@aa-game/protocol";

export interface AgentChatPanelProps {
  projectId: string;
  files: Record<string, string>;
  configValues: GameConfigValues;
  externalFixPrompt: string | null;
  onConsumeExternalFix: () => void;
  onApplyFileUpdate: (path: string, content: string, origin: "agent" | "bridge") => void;
  onVerifyReport: (report: FullVerifyReport) => void;
  onRequestBuild: () => void;
  onRunL3Probe: () => Promise<RuntimeProbeResult>;
  onBridgeReadyChange: (sendFileToBridge: ((path: string, content: string) => void) | null) => void;
}

const CLOUD_STORAGE_KEY = "aa-game-cloud-byok-config";

const CLOUD_PRESETS: Array<{ label: string; config: Partial<CloudModelConfig> }> = [
  {
    label: "OpenAI",
    config: { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  },
  {
    label: "DeepSeek",
    config: { provider: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  },
  {
    label: "Anthropic",
    config: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514" },
  },
  {
    label: "Gemini (Compat)",
    config: {
      provider: "openai-compatible",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.5-flash",
    },
  },
  {
    label: "Ollama 本地",
    config: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:14b" },
  },
];

export function AgentChatPanel({
  projectId,
  files,
  configValues,
  externalFixPrompt,
  onConsumeExternalFix,
  onApplyFileUpdate,
  onVerifyReport,
  onRequestBuild,
  onRunL3Probe,
  onBridgeReadyChange,
}: AgentChatPanelProps) {
  const [agentMode, setAgentMode] = useState<AgentMode>("local-acp");
  const [workflowMode, setWorkflowMode] = useState<CreationWorkflowMode>("spec-confirm");
  const [messages, setMessages] = useState<AgentChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "欢迎来到 AI 游戏创作工作台！你可以选择「🔌 本地 ACP Agent（连接本机 Bridge 并注入 Game Harness MCP）」或「☁️ 云端 / BYOK 模型」，并自由切换「策划卡确认」或「极速直出」模式。",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [phaseBanner, setPhaseBanner] = useState<string>("");

  // Local Bridge (ACP + MCP) state
  const [bridgeUrl, setBridgeUrl] = useState("ws://127.0.0.1:4318");
  const [bridgeToken, setBridgeToken] = useState("");
  const [bridgeStatus, setBridgeStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [bridgeError, setBridgeError] = useState("");
  const [localWorkspaceDir, setLocalWorkspaceDir] = useState("");
  const [acpAgents, setAcpAgents] = useState<AcpAgentDescriptor[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("builtin-demo-acp");
  const [customAgentCmd, setCustomAgentCmd] = useState("");
  const [acpSessionId, setAcpSessionId] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<AcpPermissionRequest | null>(null);

  // Cloud / BYOK state
  const [cloudConfig, setCloudConfig] = useState<CloudModelConfig>({
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  });
  const [showCloudSettings, setShowCloudSettings] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(1);
  const activeAssistantMsgIdRef = useRef<string | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // Load saved BYOK config from localStorage
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CLOUD_STORAGE_KEY);
      if (saved) setCloudConfig(JSON.parse(saved) as CloudModelConfig);
    } catch {
      // ignore
    }
  }, []);

  const updateCloudConfig = (patch: Partial<CloudModelConfig>) => {
    setCloudConfig((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(CLOUD_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const sendBridge = useCallback((msg: BridgeClientMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Re-sync project files to Local Bridge whenever template/projectId changes while connected
  useEffect(() => {
    if (bridgeStatus === "connected") {
      revisionRef.current += 1;
      setAcpSessionId(null);
      sendBridge({
        type: "sync_project",
        projectId,
        revision: revisionRef.current,
        files: filesRef.current,
      });
    }
  }, [bridgeStatus, projectId, sendBridge]);

  const disconnectBridge = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setBridgeStatus("disconnected");
    setAcpSessionId(null);
    setLocalWorkspaceDir("");
    setPendingPermission(null);
    onBridgeReadyChange(null);
  }, [onBridgeReadyChange]);

  const connectBridge = useCallback(() => {
    if (!bridgeToken.trim()) {
      setBridgeError("请先填入终端运行 Bridge 后显示的 Pairing Token");
      return;
    }
    setBridgeError("");
    setBridgeStatus("connecting");

    const ws = new WebSocket(bridgeUrl.trim());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: bridgeToken.trim() }));
    };

    ws.onmessage = async (event) => {
      let msg: BridgeServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as BridgeServerMessage;
      } catch {
        return;
      }

      if (msg.type === "auth_error") {
        setBridgeError(msg.message);
        setBridgeStatus("disconnected");
        ws.close();
        return;
      }

      if (msg.type === "auth_ok") {
        setBridgeStatus("connected");
        setAcpAgents(msg.agents);
        const firstReady = msg.agents.find((a) => a.available);
        if (firstReady) setSelectedAgentId(firstReady.id);

        onBridgeReadyChange((filePath, content) => {
          revisionRef.current += 1;
          sendBridge({
            type: "web_file_update",
            projectId,
            revision: revisionRef.current,
            path: filePath,
            content,
          });
        });

        revisionRef.current += 1;
        sendBridge({
          type: "sync_project",
          projectId,
          revision: revisionRef.current,
          files: filesRef.current,
        });
        return;
      }

      if (msg.type === "project_synced") {
        setLocalWorkspaceDir(msg.workspaceDir);
        return;
      }

      if (msg.type === "local_file_changed") {
        revisionRef.current = Math.max(revisionRef.current, msg.revision);
        onApplyFileUpdate(msg.path, msg.content, "bridge");
        if (msg.path === "spec.json") {
          try {
            const parsedSpec = JSON.parse(msg.content) as GameSpec;
            const targetId = activeAssistantMsgIdRef.current;
            if (targetId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === targetId ? { ...m, specCard: { spec: parsedSpec, confirmed: false } } : m,
                ),
              );
            }
          } catch {
            // ignore partial json
          }
        }
        return;
      }

      if (msg.type === "acp_session_started") {
        setAcpSessionId(msg.sessionId);
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_${Date.now()}`,
            role: "system",
            content: `已通过 ACP 启动本地 Agent「${msg.agentName}」，Game Harness MCP Server 已自动注入。`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      if (msg.type === "acp_permission_request") {
        setPendingPermission(msg.request);
        return;
      }

      if (msg.type === "request_web_probe") {
        const probeRes = await onRunL3Probe();
        sendBridge({ type: "web_probe_result", probeId: msg.probeId, result: probeRes });
        return;
      }

      if (msg.type === "acp_update") {
        const targetId = activeAssistantMsgIdRef.current;
        if (!targetId) return;
        const u = msg.update;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== targetId) return m;
            if (u.sessionUpdate === "agent_message_chunk") {
              return { ...m, content: m.content + u.content.text };
            }
            if (u.sessionUpdate === "agent_thought_chunk") {
              return { ...m, thought: (m.thought || "") + u.content.text };
            }
            if (u.sessionUpdate === "tool_call") {
              const existing = m.toolCalls ?? [];
              return {
                ...m,
                toolCalls: [
                  ...existing,
                  {
                    id: u.toolCallId,
                    name: u.title,
                    args: u.rawInput,
                    status: u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running",
                  },
                ],
              };
            }
            if (u.sessionUpdate === "tool_call_update") {
              return {
                ...m,
                toolCalls: (m.toolCalls ?? []).map((tc) =>
                  tc.id === u.toolCallId
                    ? {
                        ...tc,
                        status:
                          u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running",
                      }
                    : tc,
                ),
              };
            }
            return m;
          }),
        );
        return;
      }

      if (msg.type === "acp_prompt_done") {
        setIsBusy(false);
        setPhaseBanner("");
        activeAssistantMsgIdRef.current = null;
        setTimeout(() => onRequestBuild(), 120);
        return;
      }

      if (msg.type === "error") {
        setIsBusy(false);
        setPhaseBanner("");
        setBridgeError(msg.message);
      }
    };

    ws.onerror = () => {
      setBridgeError("无法连接本地 Bridge，请先在终端执行: corepack pnpm bridge");
      setBridgeStatus("disconnected");
    };

    ws.onclose = () => {
      setBridgeStatus("disconnected");
      setAcpSessionId(null);
      onBridgeReadyChange(null);
    };
  }, [bridgeToken, bridgeUrl, onApplyFileUpdate, onBridgeReadyChange, onRequestBuild, onRunL3Probe, projectId, sendBridge]);

  const startAcpSession = () => {
    if (bridgeStatus !== "connected") return;
    if (selectedAgentId === "custom" && customAgentCmd.trim()) {
      const parts = customAgentCmd.trim().split(/\s+/);
      sendBridge({
        type: "acp_start_session",
        projectId,
        agentId: "custom",
        customCommand: parts[0],
        customArgs: parts.slice(1),
      });
    } else {
      sendBridge({
        type: "acp_start_session",
        projectId,
        agentId: selectedAgentId,
      });
    }
  };

  const runPrompt = useCallback(
    async (
      promptText: string,
      phase: "spec" | "implement" | "iterate" | "fix",
      overrideWorkflow?: CreationWorkflowMode,
    ) => {
      const trimmed = promptText.trim();
      if (!trimmed || isBusy) return;
      const wf = overrideWorkflow ?? workflowMode;

      const userMsg: AgentChatMessage = {
        id: `u_${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };
      const assistantId = `a_${Date.now() + 1}`;
      const assistantMsg: AgentChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        toolCalls: [],
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      activeAssistantMsgIdRef.current = assistantId;
      setIsBusy(true);

      if (agentMode === "local-acp") {
        if (bridgeStatus !== "connected" || !acpSessionId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: "⚠️ 请先在上方连接 Local Bridge 并点击「启动 ACP 会话」。" }
                : m,
            ),
          );
          setIsBusy(false);
          activeAssistantMsgIdRef.current = null;
          return;
        }
        setPhaseBanner("本地 ACP Agent 交互中（Thin Editor 原话透传）...");
        sendBridge({
          type: "acp_prompt",
          sessionId: acpSessionId,
          prompt: trimmed,
          workflowMode: wf,
          phase,
        });
        return;
      }

      // Cloud / BYOK streaming route
      if (!cloudConfig.apiKey.trim()) {
        setShowCloudSettings(true);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: "⚠️ 请先在上方填写云端 / BYOK API Key，或切换到「本地 ACP Agent」模式。" }
              : m,
          ),
        );
        setIsBusy(false);
        return;
      }

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workflowMode: wf,
            phase,
            prompt: trimmed,
            history: messages
              .filter((m) => m.role === "user" || m.role === "assistant")
              .slice(-6)
              .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            files: filesRef.current,
            configValues,
            modelConfig: cloudConfig,
          }),
        });

        if (!res.ok || !res.body) {
          const text = await res.text();
          throw new Error(text || `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let anyFileUpdated = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const clean = line.trim();
            if (!clean) continue;
            const ev = JSON.parse(clean) as CloudAgentEvent;

            if (ev.type === "phase") {
              setPhaseBanner(ev.label);
            } else if (ev.type === "text_delta") {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + ev.text } : m)),
              );
            } else if (ev.type === "tool_call") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        toolCalls: [
                          ...(m.toolCalls ?? []),
                          { id: ev.id, name: ev.name, args: ev.args, status: "running" },
                        ],
                      }
                    : m,
                ),
              );
            } else if (ev.type === "tool_result") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        toolCalls: (m.toolCalls ?? []).map((tc) =>
                          tc.id === ev.id
                            ? { ...tc, status: ev.ok ? "done" : "error", resultSummary: ev.summary }
                            : tc,
                        ),
                      }
                    : m,
                ),
              );
            } else if (ev.type === "spec_card") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, specCard: { spec: ev.spec, confirmed: false } }
                    : m,
                ),
              );
            } else if (ev.type === "file_update") {
              anyFileUpdated = true;
              onApplyFileUpdate(ev.path, ev.content, "agent");
            } else if (ev.type === "verify_report") {
              onVerifyReport(ev.report);
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, verifyReport: ev.report } : m)),
              );
            } else if (ev.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: `${m.content}\n❌ ${ev.message}` } : m,
                ),
              );
            }
          }
        }

        if (anyFileUpdated) {
          setTimeout(() => onRequestBuild(), 120);
        }
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `❌ 请求失败: ${err instanceof Error ? err.message : String(err)}` }
              : m,
          ),
        );
      } finally {
        setIsBusy(false);
        setPhaseBanner("");
        activeAssistantMsgIdRef.current = null;
      }
    },
    [
      acpSessionId,
      agentMode,
      bridgeStatus,
      cloudConfig,
      configValues,
      isBusy,
      messages,
      onApplyFileUpdate,
      onRequestBuild,
      onVerifyReport,
      sendBridge,
      workflowMode,
    ],
  );

  // Triggered when user clicks "Send runtime error to AI for auto-fix" in Console
  useEffect(() => {
    if (externalFixPrompt) {
      const prompt = externalFixPrompt;
      onConsumeExternalFix();
      void runPrompt(prompt, "fix");
    }
  }, [externalFixPrompt, onConsumeExternalFix, runPrompt]);

  const handleConfirmSpecCard = (msgId: string, spec: GameSpec) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId && m.specCard ? { ...m, specCard: { spec, confirmed: true } } : m)),
    );
    onApplyFileUpdate("spec.json", JSON.stringify(spec, null, 2), "agent");
    void runPrompt(`请严格按照已确认的策划卡「${spec.title}」实现完整可玩代码并通过自检。`, "implement");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Agent Engine Mode Switcher */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #1e293b", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["local-acp", "🔌 本地 ACP Agent"],
              ["cloud-byok", "☁️ 云端 / BYOK"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setAgentMode(mode)}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 8,
                border: "1px solid #334155",
                background: agentMode === mode ? "#0284c7" : "#111827",
                color: agentMode === mode ? "#fff" : "#94a3b8",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Thin Editor notice for Local ACP vs Outer Harness workflow toggle for Cloud/BYOK */}
        {agentMode === "local-acp" ? (
          <div
            style={{
              fontSize: 11,
              color: "#94a3b8",
              background: "rgba(15,23,42,0.75)",
              border: "1px solid #1e293b",
              borderRadius: 7,
              padding: "5px 8px",
              lineHeight: 1.45,
            }}
          >
            <b style={{ color: "#38bdf8" }}>Thin Editor 模式</b>：用户原话直接透传本地 Agent，项目规范通过工作区{" "}
            <code>AGENTS.md</code> / <code>GEMINI.md</code> 与标准 MCP 提供。建议为外部客户端配置开发者 API Key（如{" "}
            <code>GEMINI_API_KEY</code> / Vertex AI）。
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11 }}>
            <span style={{ color: "#94a3b8" }}>Harness 起步模式：</span>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => setWorkflowMode("spec-confirm")}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: workflowMode === "spec-confirm" ? "rgba(56,189,248,0.2)" : "#0f172a",
                  color: workflowMode === "spec-confirm" ? "#38bdf8" : "#94a3b8",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                📋 策划卡确认
              </button>
              <button
                onClick={() => setWorkflowMode("fast-direct")}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: workflowMode === "fast-direct" ? "rgba(52,211,153,0.2)" : "#0f172a",
                  color: workflowMode === "fast-direct" ? "#34d399" : "#94a3b8",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                ⚡ 极速直出
              </button>
            </div>
          </div>
        )}

        {/* Local Bridge ACP Connection Panel */}
        {agentMode === "local-acp" && (
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 10, padding: 10, fontSize: 11 }}>
            {bridgeStatus !== "connected" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ color: "#94a3b8" }}>
                  终端启动桥接：<code style={{ color: "#38bdf8" }}>corepack pnpm bridge</code>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={bridgeUrl}
                    onChange={(e) => setBridgeUrl(e.target.value)}
                    placeholder="ws://127.0.0.1:4318"
                    style={{
                      flex: 1,
                      background: "#070b14",
                      border: "1px solid #334155",
                      borderRadius: 6,
                      padding: "5px 7px",
                      color: "#e2e8f0",
                      fontSize: 11,
                    }}
                  />
                  <input
                    value={bridgeToken}
                    onChange={(e) => setBridgeToken(e.target.value)}
                    placeholder="Pairing Token"
                    style={{
                      width: 115,
                      background: "#070b14",
                      border: "1px solid #334155",
                      borderRadius: 6,
                      padding: "5px 7px",
                      color: "#e2e8f0",
                      fontSize: 11,
                      fontFamily: "monospace",
                    }}
                  />
                  <button
                    onClick={connectBridge}
                    style={{
                      background: "#10b981",
                      color: "#052e16",
                      border: "none",
                      borderRadius: 6,
                      padding: "5px 10px",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    连接
                  </button>
                </div>
                {bridgeError && <div style={{ color: "#fb7185" }}>{bridgeError}</div>}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#34d399", fontWeight: 700 }}>
                    ● Bridge 已连接 {acpSessionId ? "· ACP 会话活跃 (MCP 已注入)" : ""}
                  </span>
                  <button
                    onClick={disconnectBridge}
                    style={{
                      background: "transparent",
                      border: "1px solid #475569",
                      color: "#cbd5e1",
                      borderRadius: 5,
                      padding: "2px 6px",
                      fontSize: 10,
                      cursor: "pointer",
                    }}
                  >
                    断开
                  </button>
                </div>
                {localWorkspaceDir && (
                  <div style={{ color: "#64748b", fontFamily: "monospace", fontSize: 10, wordBreak: "break-all" }}>
                    双向镜像目录: {localWorkspaceDir}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    style={{
                      flex: 1,
                      background: "#070b14",
                      color: "#f8fafc",
                      border: "1px solid #334155",
                      borderRadius: 6,
                      padding: "4px 6px",
                      fontSize: 11,
                    }}
                  >
                    {acpAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.available ? "✓" : "○"} {a.name}
                      </option>
                    ))}
                    <option value="custom">⚙ 自定义本机 ACP 命令...</option>
                  </select>
                  <button
                    onClick={startAcpSession}
                    style={{
                      background: "#0284c7",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {acpSessionId ? "重启会话" : "启动 ACP"}
                  </button>
                </div>
                {selectedAgentId === "custom" && (
                  <input
                    value={customAgentCmd}
                    onChange={(e) => setCustomAgentCmd(e.target.value)}
                    placeholder="例如: agy acp、gemini --acp 或 claude-code-acp"
                    style={{
                      background: "#070b14",
                      border: "1px solid #334155",
                      borderRadius: 6,
                      padding: "5px 7px",
                      color: "#e2e8f0",
                      fontSize: 11,
                      fontFamily: "monospace",
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {/* Cloud / BYOK Settings Drawer */}
        {agentMode === "cloud-byok" && (
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 10, padding: 8, fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: cloudConfig.apiKey ? "#34d399" : "#fbbf24", fontWeight: 700 }}>
                {cloudConfig.model} ({cloudConfig.apiKey ? "Key 已配置" : "未填 Key"})
              </span>
              <button
                onClick={() => setShowCloudSettings((s) => !s)}
                style={{
                  background: "#1e293b",
                  color: "#e2e8f0",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "2px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {showCloudSettings ? "收起配置" : "配置模型 / BYOK"}
              </button>
            </div>
            {showCloudSettings && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {CLOUD_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => updateCloudConfig(p.config)}
                      style={{
                        padding: "2px 7px",
                        borderRadius: 5,
                        border: "1px solid #334155",
                        background: "#0f172a",
                        color: "#38bdf8",
                        fontSize: 10,
                        cursor: "pointer",
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  value={cloudConfig.baseUrl}
                  onChange={(e) => updateCloudConfig({ baseUrl: e.target.value })}
                  placeholder="Base URL"
                  style={{ background: "#070b14", border: "1px solid #334155", borderRadius: 6, padding: "5px 7px", color: "#e2e8f0", fontSize: 11 }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={cloudConfig.model}
                    onChange={(e) => updateCloudConfig({ model: e.target.value })}
                    placeholder="Model ID"
                    style={{ flex: 1, background: "#070b14", border: "1px solid #334155", borderRadius: 6, padding: "5px 7px", color: "#e2e8f0", fontSize: 11 }}
                  />
                  <input
                    type="password"
                    value={cloudConfig.apiKey}
                    onChange={(e) => updateCloudConfig({ apiKey: e.target.value })}
                    placeholder="API Key (仅存本地浏览器)"
                    style={{ flex: 1, background: "#070b14", border: "1px solid #334155", borderRadius: 6, padding: "5px 7px", color: "#e2e8f0", fontSize: 11 }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ACP Permission Prompt Banner */}
      {pendingPermission && (
        <div
          style={{
            margin: "8px 12px 0",
            padding: 10,
            borderRadius: 10,
            background: "rgba(245,158,11,0.14)",
            border: "1px solid #f59e0b",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 700, color: "#fbbf24" }}>🔐 ACP 权限确认：{pendingPermission.title}</div>
          {pendingPermission.description && (
            <div style={{ fontSize: 11, color: "#fde68a", marginTop: 4 }}>{pendingPermission.description}</div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {pendingPermission.options.map((opt) => (
              <button
                key={opt.optionId}
                onClick={() => {
                  sendBridge({
                    type: "acp_permission_response",
                    requestId: pendingPermission.requestId,
                    optionId: opt.optionId,
                  });
                  setPendingPermission(null);
                }}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: opt.kind.startsWith("allow") ? "#10b981" : "#475569",
                  color: opt.kind.startsWith("allow") ? "#052e16" : "#f8fafc",
                  fontWeight: 700,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {opt.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chat Messages Stream */}
      <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              alignSelf: msg.role === "user" ? "flex-end" : "stretch",
              maxWidth: msg.role === "user" ? "88%" : "100%",
              background:
                msg.role === "user"
                  ? "#0369a1"
                  : msg.role === "system"
                    ? "rgba(56,189,248,0.12)"
                    : "#111827",
              border: `1px solid ${msg.role === "user" ? "#0284c7" : "#1f2937"}`,
              borderRadius: 10,
              padding: "8px 10px",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            {msg.thought && (
              <details style={{ marginBottom: 6, color: "#94a3b8", fontSize: 11 }}>
                <summary style={{ cursor: "pointer" }}>💭 Agent 思考过程</summary>
                <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{msg.thought}</div>
              </details>
            )}

            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }}>
                {msg.toolCalls.map((tc) => (
                  <div
                    key={tc.id}
                    style={{
                      fontSize: 11,
                      padding: "4px 7px",
                      borderRadius: 6,
                      background: "#070b14",
                      border: `1px solid ${tc.status === "error" ? "#f43f5e" : tc.status === "done" ? "#10b981" : "#38bdf8"}`,
                      fontFamily: "monospace",
                    }}
                  >
                    <span>
                      {tc.status === "running" ? "⏳" : tc.status === "done" ? "✅" : "❌"} {tc.name}
                    </span>
                    {tc.resultSummary && (
                      <div style={{ color: "#94a3b8", marginTop: 2, fontFamily: "system-ui" }}>
                        {tc.resultSummary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {msg.content && <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>}

            {msg.specCard && (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 8,
                  background: "#070b14",
                  border: "1px solid #38bdf8",
                }}
              >
                <div style={{ fontWeight: 800, color: "#38bdf8", marginBottom: 4 }}>
                  📋 轻量策划卡：{msg.specCard.spec.title}
                </div>
                <div style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 6 }}>
                  {msg.specCard.spec.description}
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <span>模式: {msg.specCard.spec.mode}</span>
                  <span>方向: {msg.specCard.spec.orientation}</span>
                  <span>
                    画布: {msg.specCard.spec.worldSize.width}×{msg.specCard.spec.worldSize.height}
                  </span>
                  <span>最大人数: {msg.specCard.spec.maxPlayers}</span>
                </div>
                <button
                  disabled={msg.specCard.confirmed || isBusy}
                  onClick={() => handleConfirmSpecCard(msg.id, msg.specCard!.spec)}
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 7,
                    border: "none",
                    background: msg.specCard.confirmed ? "#334155" : "#10b981",
                    color: msg.specCard.confirmed ? "#94a3b8" : "#052e16",
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: msg.specCard.confirmed ? "default" : "pointer",
                  }}
                >
                  {msg.specCard.confirmed ? "✅ 已确认并开始生成代码" : "🚀 确认策划卡并生成可玩代码"}
                </button>
              </div>
            )}
          </div>
        ))}
        {phaseBanner && (
          <div style={{ fontSize: 11, color: "#38bdf8", textAlign: "center", padding: 4 }}>
            ⏳ {phaseBanner}
          </div>
        )}
      </div>

      {/* Prompt Composer */}
      <div style={{ padding: 10, borderTop: "1px solid #1e293b", background: "#090d16" }}>
        <div style={{ display: "flex", gap: 5, marginBottom: 6, flexWrap: "wrap" }}>
          {["提高移动速度并加一个护盾资产", "做一个双人联机弹球对战", "把难度调高并增加连击得分"].map((idea) => (
            <button
              key={idea}
              onClick={() => setInput(idea)}
              style={{
                fontSize: 10,
                padding: "2px 7px",
                borderRadius: 999,
                border: "1px solid #334155",
                background: "#111827",
                color: "#94a3b8",
                cursor: "pointer",
              }}
            >
              {idea}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = input;
                setInput("");
                void runPrompt(text, workflowMode === "spec-confirm" ? "spec" : "iterate");
              }
            }}
            placeholder="输入游戏想法或迭代要求（Enter 发送，Shift+Enter 换行）..."
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              background: "#111827",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "7px 9px",
              color: "#f8fafc",
              fontSize: 12,
              outline: "none",
            }}
          />
          <button
            disabled={isBusy || !input.trim()}
            onClick={() => {
              const text = input;
              setInput("");
              void runPrompt(text, workflowMode === "spec-confirm" ? "spec" : "iterate");
            }}
            style={{
              background: "#0284c7",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0 14px",
              fontWeight: 700,
              fontSize: 12,
              cursor: isBusy ? "not-allowed" : "pointer",
            }}
          >
            {isBusy ? "..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
