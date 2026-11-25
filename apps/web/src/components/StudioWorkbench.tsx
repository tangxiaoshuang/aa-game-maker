"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { BUILTIN_TEMPLATES, type TemplateProject } from "@aa-game/templates";
import type {
  AssetEntry,
  AssetManifest,
  ConfigParam,
  CreateRoomResponse,
  DeviceViewportMode,
  FullVerifyReport,
  GameConfigValues,
  GameSpec,
  PlayerToWorkbenchMessage,
  ProjectDetail,
  ProjectSummary,
  RuntimeLogEntry,
  RuntimeMetrics,
  RuntimeProbeResult,
  SmokeTestResponse,
  UserProfile,
  WorkbenchToPlayerMessage,
} from "@aa-game/protocol";
import { compileGameProject } from "@/lib/bundler";
import { platformApi } from "@/lib/platform-api";
import { AgentChatPanel } from "@/components/AgentChatPanel";
import { AuthModal } from "@/components/AuthModal";
import {
  AssetUploadAndGenPanel,
  PublishModal,
  SnapshotHistoryModal,
} from "@/components/PlatformDrawers";

const PLAYER_ORIGIN = process.env.NEXT_PUBLIC_PLAYER_ORIGIN || "http://localhost:3001";
const ROOM_API_URL = process.env.NEXT_PUBLIC_ROOM_SERVER_URL || "http://localhost:4000";
const ROOM_WS_URL = process.env.NEXT_PUBLIC_ROOM_WS_URL || "ws://localhost:4000";

type LeftTab = "agent" | "tuning" | "files" | "verify";

interface ServerHealth {
  ok: boolean;
  engine: string;
  workerdHealthy: boolean;
  redisConnected: boolean;
  activeRooms: number;
  lanIp: string;
}

interface CatalogSearchItem {
  id: string;
  name: string;
  kind: AssetEntry["kind"];
  source: AssetEntry["source"];
  style: string;
  description: string;
  url?: string;
  sfxPreset?: AssetEntry["sfxPreset"];
  width?: number;
  height?: number;
}

export function StudioWorkbench() {
  const [activeTemplateId, setActiveTemplateId] = useState<string>(BUILTIN_TEMPLATES[0]!.id);
  const template: TemplateProject = useMemo(
    () => BUILTIN_TEMPLATES.find((t) => t.id === activeTemplateId) ?? BUILTIN_TEMPLATES[0]!,
    [activeTemplateId],
  );

  const [files, setFiles] = useState<Record<string, string>>(() => ({ ...template.files }));
  const [activeFile, setActiveFile] = useState<string>("simulation.ts");
  const [configSchema, setConfigSchema] = useState<ConfigParam[]>(() => [...template.configSchema]);
  const [configValues, setConfigValues] = useState<GameConfigValues>(() => ({
    ...template.defaultConfig,
  }));

  const [leftTab, setLeftTab] = useState<LeftTab>("agent");
  const [deviceMode, setDeviceMode] = useState<DeviceViewportMode>("pc");
  const [splitMultiplayer, setSplitMultiplayer] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);

  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [roomInfo, setRoomInfo] = useState<CreateRoomResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [qrJoinUrl, setQrJoinUrl] = useState<string>("");
  const [showQrModal, setShowQrModal] = useState<boolean>(false);

  // Milestone 3: Auth, Cloud Projects, Snapshots, Publish & Export
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [cloudProjects, setCloudProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectDetail | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [metrics, setMetrics] = useState<RuntimeMetrics>({ fps: 0, tick: 0 });
  const [verifyReport, setVerifyReport] = useState<FullVerifyReport | null>(null);
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [externalFixPrompt, setExternalFixPrompt] = useState<string | null>(null);

  const [assetQuery, setAssetQuery] = useState<string>("");
  const [catalogResults, setCatalogResults] = useState<CatalogSearchItem[]>([]);

  const primaryFrameRef = useRef<HTMLIFrameElement | null>(null);
  const secondaryFrameRef = useRef<HTMLIFrameElement | null>(null);
  const probeResolverRef = useRef<((res: RuntimeProbeResult) => void) | null>(null);
  const bridgePushFileRef = useRef<((path: string, content: string) => void) | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const appendLog = useCallback((level: RuntimeLogEntry["level"], message: string) => {
    setLogs((prev) => [...prev.slice(-40), { level, message, timestamp: Date.now() }]);
  }, []);

  const postToFrames = useCallback((msg: WorkbenchToPlayerMessage, target?: "primary" | "secondary") => {
    if ((!target || target === "primary") && primaryFrameRef.current?.contentWindow) {
      primaryFrameRef.current.contentWindow.postMessage(msg, "*");
    }
    if ((!target || target === "secondary") && secondaryFrameRef.current?.contentWindow) {
      secondaryFrameRef.current.contentWindow.postMessage(msg, "*");
    }
  }, []);

  const parseSpecAndAssets = useCallback(
    (sourceFiles: Record<string, string>): { spec: GameSpec; assets: AssetManifest } => {
      let spec = template.spec;
      let assets = template.assets;
      try {
        if (sourceFiles["spec.json"]) spec = JSON.parse(sourceFiles["spec.json"]) as GameSpec;
      } catch {
        // fallback
      }
      try {
        if (sourceFiles["assets.json"]) assets = JSON.parse(sourceFiles["assets.json"]) as AssetManifest;
      } catch {
        // fallback
      }
      return { spec, assets };
    },
    [template],
  );

  // Poll room-server & workerd health
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch(`${ROOM_API_URL}/health`);
        if (res.ok && mounted) setHealth((await res.json()) as ServerHealth);
      } catch {
        if (mounted) setHealth(null);
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  // Load CC0 catalog
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/assets/search?q=${encodeURIComponent(assetQuery)}&limit=8`);
        if (res.ok && active) {
          const data = (await res.json()) as { items: CatalogSearchItem[] };
          setCatalogResults(data.items ?? []);
        }
      } catch {
        // ignore
      }
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [assetQuery]);

  // Listen to player iframe
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PlayerToWorkbenchMessage | undefined;
      if (!data || data.channel !== "aa-game-sandbox") return;
      if (data.type === "RUNTIME_LOG") {
        setLogs((prev) => [...prev.slice(-40), data.entry]);
      } else if (data.type === "METRICS") {
        if (event.source === primaryFrameRef.current?.contentWindow) setMetrics(data.metrics);
      } else if (data.type === "PROBE_RESULT") {
        if (probeResolverRef.current) {
          probeResolverRef.current(data.result);
          probeResolverRef.current = null;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const runL3Probe = useCallback(async (): Promise<RuntimeProbeResult> => {
    return new Promise<RuntimeProbeResult>((resolve) => {
      const timeout = setTimeout(() => {
        probeResolverRef.current = null;
        resolve({
          ok: false,
          blankCanvas: true,
          nonZeroPixelRatio: 0,
          errors: [{ level: "error", message: "L3 iframe 探针超时", timestamp: Date.now() }],
          durationMs: 3000,
        });
      }, 3000);
      probeResolverRef.current = (res) => {
        clearTimeout(timeout);
        resolve(res);
      };
      postToFrames({ channel: "aa-game-sandbox", type: "RUN_PROBE" }, "primary");
    });
  }, [postToFrames]);

  const buildAndLaunch = useCallback(
    async (opts?: {
      sourceFiles?: Record<string, string>;
      cfg?: GameConfigValues;
      enableSplit?: boolean;
      overrideDeviceMode?: DeviceViewportMode;
    }) => {
      const curFiles = opts?.sourceFiles ?? filesRef.current;
      const curConfig = opts?.cfg ?? configValues;
      const useSplit = opts?.enableSplit ?? splitMultiplayer;
      const curDevice = opts?.overrideDeviceMode ?? deviceMode;

      setIsBuilding(true);
      setPaused(false);
      const compiled = await compileGameProject(curFiles);
      setIsBuilding(false);

      if (!compiled.ok) {
        appendLog(
          "error",
          `L1 编译失败 (${compiled.durationMs}ms): ${compiled.diagnostics.map((d) => d.message).join("; ")}`,
        );
        setVerifyReport({
          ok: false,
          l1Compile: { ok: false, durationMs: compiled.durationMs, diagnostics: compiled.diagnostics },
          l2Smoke: null,
          l3Runtime: null,
        });
        return compiled;
      }

      appendLog("info", `L1 浏览器 esbuild-wasm 编译成功 (${compiled.durationMs}ms)`);
      const { spec, assets } = parseSpecAndAssets(curFiles);
      let activeRoom: CreateRoomResponse | null = null;

      if (spec.mode === "multiplayer") {
        try {
          const roomRes = await fetch(`${ROOM_API_URL}/api/rooms`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              gameId: spec.id,
              title: spec.title,
              simBundle: compiled.simBundle,
              clientBundle: compiled.clientBundle,
              spec,
              configSchema,
              configValues: curConfig,
              assets,
              maxPlayers: spec.maxPlayers,
              tickRate: spec.tickRate,
              autoStart: true,
            }),
          });
          if (!roomRes.ok) throw new Error(await roomRes.text());
          activeRoom = (await roomRes.json()) as CreateRoomResponse;
          setRoomInfo(activeRoom);
          appendLog("info", `已创建 workerd 权威房间 ${activeRoom.roomCode} (${activeRoom.roomId})`);

          const lanHost = health?.lanIp || window.location.hostname;
          const playerPort = new URL(PLAYER_ORIGIN).port || "3001";
          const apiPort = new URL(ROOM_API_URL).port || "4000";
          const joinUrl = `http://${lanHost}:${playerPort}/?room=${activeRoom.roomCode}&api=${encodeURIComponent(`http://${lanHost}:${apiPort}`)}`;
          setQrJoinUrl(joinUrl);
          setQrDataUrl(await QRCode.toDataURL(joinUrl, { width: 220, margin: 1 }));
        } catch (err) {
          appendLog("error", `创建 workerd 联机房间失败: ${String(err)}`);
        }
      } else {
        setRoomInfo(null);
        setQrDataUrl("");
        setQrJoinUrl("");
      }

      const loadPayloadBase = {
        spec,
        configSchema,
        configValues: curConfig,
        assets,
        clientBundle: compiled.clientBundle,
        simBundle: compiled.simBundle,
        deviceMode: curDevice,
        roomWsUrl: activeRoom ? `${ROOM_WS_URL}${activeRoom.wsPath}` : undefined,
        roomId: activeRoom?.roomId,
        roomCode: activeRoom?.roomCode,
      };

      postToFrames(
        {
          channel: "aa-game-sandbox",
          type: "LOAD_GAME",
          payload: { ...loadPayloadBase, playerName: user?.displayName || "PC 玩家 1" },
        },
        "primary",
      );

      if (useSplit && spec.mode === "multiplayer" && activeRoom) {
        setTimeout(() => {
          postToFrames(
            {
              channel: "aa-game-sandbox",
              type: "LOAD_GAME",
              payload: { ...loadPayloadBase, deviceMode: "mobile-landscape", playerName: "模拟玩家 2" },
            },
            "secondary",
          );
        }, 180);
      }

      return compiled;
    },
    [
      appendLog,
      configSchema,
      configValues,
      deviceMode,
      health?.lanIp,
      parseSpecAndAssets,
      postToFrames,
      splitMultiplayer,
      user?.displayName,
    ],
  );

  const loadCloudProjectDetail = useCallback(
    async (projectId: string) => {
      const res = await platformApi.getProject(projectId);
      const proj = res.project;
      setCurrentProject(proj);
      setFiles(proj.files);
      filesRef.current = proj.files;
      if (proj.configSchema?.length) setConfigSchema(proj.configSchema);
      let nextCfg: GameConfigValues = {};
      try {
        if (proj.files["config.json"]) nextCfg = JSON.parse(proj.files["config.json"]) as GameConfigValues;
      } catch {
        // ignore
      }
      setConfigValues(nextCfg);
      const nextDevice: DeviceViewportMode =
        proj.orientation === "portrait" ? "mobile-portrait" : "pc";
      const nextSplit = proj.mode === "multiplayer";
      setDeviceMode(nextDevice);
      setSplitMultiplayer(nextSplit);
      appendLog("info", `已加载云端项目「${proj.title}」(${proj.snapshots.length} 个快照)`);
      setTimeout(() => {
        void buildAndLaunch({
          sourceFiles: proj.files,
          cfg: nextCfg,
          enableSplit: nextSplit,
          overrideDeviceMode: nextDevice,
        });
      }, 200);
    },
    [appendLog, buildAndLaunch],
  );

  // Restore session & open ?project=<id> if navigated from Gallery Remix
  const refreshUserAndProjects = useCallback(async () => {
    try {
      const { user: me } = await platformApi.me();
      setUser(me);
      if (me) {
        const { projects } = await platformApi.listProjects();
        setCloudProjects(projects);
      } else {
        setCloudProjects([]);
      }
    } catch {
      // API server optional during offline dev
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshUserAndProjects();
      const params = new URLSearchParams(window.location.search);
      const projectId = params.get("project");
      if (projectId) {
        try {
          await loadCloudProjectDetail(projectId);
        } catch (err) {
          appendLog("warn", `加载云端项目失败: ${String(err)}`);
        }
      }
    })();
  }, [appendLog, loadCloudProjectDetail, refreshUserAndProjects]);

  const ensureCloudProject = useCallback(async (): Promise<ProjectDetail> => {
    if (!user) {
      setAuthModalOpen(true);
      throw new Error("请先登录创作者账号");
    }
    if (currentProject) return currentProject;
    const { spec } = parseSpecAndAssets(filesRef.current);
    const created = await platformApi.createProject({
      title: spec.title || template.name,
      description: spec.description || template.tagline,
      files: filesRef.current,
      configSchema,
    });
    setCurrentProject(created.project);
    await refreshUserAndProjects();
    return created.project;
  }, [configSchema, currentProject, parseSpecAndAssets, refreshUserAndProjects, template.name, template.tagline, user]);

  const handleSaveSnapshot = useCallback(
    async (commitSummary: string) => {
      try {
        const proj = await ensureCloudProject();
        const { spec } = parseSpecAndAssets(filesRef.current);
        const res = await platformApi.saveSnapshot(proj.id, {
          files: filesRef.current,
          commitSummary,
          title: spec.title,
          description: spec.description,
          configSchema,
        });
        setCurrentProject(res.project);
        await refreshUserAndProjects();
        appendLog("info", `💾 已保存云端快照 (${res.snapshotId}): ${commitSummary}`);
      } catch (err) {
        appendLog("error", `保存快照失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [appendLog, configSchema, ensureCloudProject, parseSpecAndAssets, refreshUserAndProjects],
  );

  const handleRollbackSnapshot = useCallback(
    async (snapshotId: string) => {
      if (!currentProject) return;
      const res = await platformApi.rollbackSnapshot(currentProject.id, snapshotId);
      const proj = res.project;
      setCurrentProject(proj);
      setFiles(proj.files);
      filesRef.current = proj.files;
      try {
        if (proj.files["config.json"]) {
          setConfigValues(JSON.parse(proj.files["config.json"]) as GameConfigValues);
        }
      } catch {
        // ignore
      }
      appendLog("info", `⏪ 已回滚至历史快照 ${snapshotId}`);
      void buildAndLaunch({ sourceFiles: proj.files });
    },
    [appendLog, buildAndLaunch, currentProject],
  );

  const handleApplyAgentFileUpdate = useCallback(
    (filePath: string, content: string, origin: "agent" | "bridge") => {
      setFiles((prev) => {
        const next = { ...prev, [filePath]: content };
        filesRef.current = next;
        return next;
      });
      if (filePath === "config.json") {
        try {
          const parsed = JSON.parse(content) as GameConfigValues;
          setConfigValues(parsed);
          postToFrames({ channel: "aa-game-sandbox", type: "UPDATE_CONFIG", configValues: parsed });
        } catch {
          // ignore
        }
      }
      if (origin === "agent") {
        bridgePushFileRef.current?.(filePath, content);
      }
      appendLog("info", `[${origin === "bridge" ? "本地 Bridge 同步" : "AI / 资产"}] 更新文件 ${filePath}`);
    },
    [appendLog, postToFrames],
  );

  const handleSelectTemplate = (tplId: string) => {
    const next = BUILTIN_TEMPLATES.find((t) => t.id === tplId);
    if (!next) return;
    setActiveTemplateId(next.id);
    setCurrentProject(null);
    const nextFiles = { ...next.files };
    const nextConfig = { ...next.defaultConfig };
    const nextDevice: DeviceViewportMode =
      next.spec.orientation === "portrait" ? "mobile-portrait" : "pc";
    const nextSplit = next.spec.mode === "multiplayer";

    setFiles(nextFiles);
    filesRef.current = nextFiles;
    setConfigSchema([...next.configSchema]);
    setConfigValues(nextConfig);
    setDeviceMode(nextDevice);
    setSplitMultiplayer(nextSplit);
    setActiveFile("simulation.ts");
    setVerifyReport(null);

    setTimeout(() => {
      void buildAndLaunch({
        sourceFiles: nextFiles,
        cfg: nextConfig,
        enableSplit: nextSplit,
        overrideDeviceMode: nextDevice,
      });
    }, 220);
  };

  const initialLaunchedRef = useRef(false);
  const handlePrimaryIframeLoad = () => {
    if (!initialLaunchedRef.current) {
      initialLaunchedRef.current = true;
      const params = new URLSearchParams(window.location.search);
      if (params.get("project")) return; // cloud project loader will launch it
      const defaultDev: DeviceViewportMode =
        template.spec.orientation === "portrait" ? "mobile-portrait" : "pc";
      setDeviceMode(defaultDev);
      void buildAndLaunch({ overrideDeviceMode: defaultDev });
    }
  };

  const handleFullVerify = async () => {
    setIsVerifying(true);
    setLeftTab("verify");
    const compiled = await buildAndLaunch();
    if (!compiled || !compiled.ok) {
      setIsVerifying(false);
      return;
    }

    const { spec } = parseSpecAndAssets(filesRef.current);
    let l2Smoke: SmokeTestResponse | null = null;
    try {
      const smokeRes = await fetch(`${ROOM_API_URL}/api/verify/smoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ simBundle: compiled.simBundle, spec, config: configValues, ticks: 120 }),
      });
      l2Smoke = (await smokeRes.json()) as SmokeTestResponse;
      appendLog(
        l2Smoke.ok ? "info" : "error",
        `L2 workerd 无头冒烟测试 ${l2Smoke.ok ? "通过" : "失败"} (${l2Smoke.ticksExecuted} ticks, max ${l2Smoke.maxTickMs}ms)`,
      );
    } catch (err) {
      l2Smoke = {
        ok: false,
        engine: "workerd",
        ticksExecuted: 0,
        durationMs: 0,
        maxTickMs: 0,
        stateBytes: 0,
        diagnostics: [{ layer: "L2_SMOKE", severity: "error", message: `无法连接 room-server: ${String(err)}` }],
      };
    }

    await new Promise((r) => setTimeout(r, 600));
    const l3Runtime = await runL3Probe();
    setVerifyReport({
      ok: compiled.ok && Boolean(l2Smoke?.ok) && l3Runtime.ok,
      l1Compile: { ok: compiled.ok, durationMs: compiled.durationMs, diagnostics: compiled.diagnostics },
      l2Smoke,
      l3Runtime,
    });
    setIsVerifying(false);
  };

  const handleConfigChange = (key: string, val: number | boolean | string) => {
    const next = { ...configValues, [key]: val };
    const serialized = JSON.stringify(next, null, 2);
    setConfigValues(next);
    setFiles((prev) => {
      const updated = { ...prev, "config.json": serialized };
      filesRef.current = updated;
      return updated;
    });
    bridgePushFileRef.current?.("config.json", serialized);
    postToFrames({ channel: "aa-game-sandbox", type: "UPDATE_CONFIG", configValues: next });
  };

  const registerAssetEntry = (entry: AssetEntry, note: string) => {
    const { assets } = parseSpecAndAssets(filesRef.current);
    const nextAssets: AssetManifest = {
      version: 1,
      assets: [...assets.assets.filter((a) => a.id !== entry.id), entry],
    };
    handleApplyAgentFileUpdate("assets.json", JSON.stringify(nextAssets, null, 2), "agent");
    appendLog("info", note);
  };

  const handleExport = async (kind: "html" | "zip") => {
    try {
      const { spec } = parseSpecAndAssets(filesRef.current);
      await platformApi.downloadExport(kind, currentProject?.title || spec.title, filesRef.current);
      appendLog("info", `📦 已导出 ${kind.toUpperCase()} 包`);
    } catch (err) {
      appendLog("error", `导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeviceSwitch = (mode: DeviceViewportMode) => {
    setDeviceMode(mode);
    postToFrames({ channel: "aa-game-sandbox", type: "SET_DEVICE_MODE", deviceMode: mode }, "primary");
  };

  const latestErrors = logs.filter((l) => l.level === "error").slice(-3);
  const currentSpec = parseSpecAndAssets(files).spec;
  const currentAssets = parseSpecAndAssets(files).assets.assets;

  const viewportBoxStyle: React.CSSProperties =
    deviceMode === "mobile-portrait"
      ? { width: 390, height: 680, maxWidth: "100%", maxHeight: "100%", borderRadius: 24 }
      : deviceMode === "mobile-landscape"
        ? { width: 720, height: 410, maxWidth: "100%", maxHeight: "100%", borderRadius: 20 }
        : { width: "100%", height: "100%", borderRadius: 12 };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#090d16", color: "#e2e8f0" }}>
      {/* Top Bar */}
      <header
        style={{
          height: 54,
          padding: "0 14px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          background: "#0f172a",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: "#38bdf8", whiteSpace: "nowrap" }}>
            AA Game Maker
          </span>
          <Link
            href="/gallery"
            style={{
              textDecoration: "none",
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 7,
              padding: "4px 9px",
              fontSize: 12,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            🕹️ 游戏广场
          </Link>
          <select
            value={activeTemplateId}
            onChange={(e) => handleSelectTemplate(e.target.value)}
            style={{
              background: "#1e293b",
              color: "#f8fafc",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "4px 8px",
              fontSize: 12,
              fontWeight: 600,
              maxWidth: 210,
            }}
          >
            {BUILTIN_TEMPLATES.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name} ({tpl.spec.mode === "multiplayer" ? "联机" : "单机"})
              </option>
            ))}
          </select>
          {currentProject && (
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background: "rgba(56,189,248,0.16)",
                color: "#38bdf8",
                whiteSpace: "nowrap",
              }}
            >
              ☁ {currentProject.title}
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              padding: "2px 7px",
              borderRadius: 999,
              background: health?.workerdHealthy ? "rgba(52,211,153,0.16)" : "rgba(244,63,94,0.16)",
              color: health?.workerdHealthy ? "#34d399" : "#fb7185",
              whiteSpace: "nowrap",
            }}
          >
            workerd:{health?.workerdHealthy ? "OK" : "离线"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => void buildAndLaunch()}
            disabled={isBuilding}
            style={{
              background: "#0284c7",
              color: "#fff",
              border: "none",
              borderRadius: 7,
              padding: "5px 10px",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {isBuilding ? "编译..." : "▶ 运行"}
          </button>

          <button
            onClick={() => void handleFullVerify()}
            disabled={isVerifying}
            style={{
              background: "#10b981",
              color: "#052e16",
              border: "none",
              borderRadius: 7,
              padding: "5px 9px",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {isVerifying ? "校验..." : "L1~L3"}
          </button>

          <button
            onClick={() => {
              if (!user) setAuthModalOpen(true);
              else setHistoryOpen(true);
            }}
            style={{
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 7,
              padding: "5px 9px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🕒 快照{currentProject ? ` (${currentProject.snapshots.length})` : ""}
          </button>

          <button
            onClick={() => {
              if (!user) setAuthModalOpen(true);
              else setPublishOpen(true);
            }}
            style={{
              background: "#7c3aed",
              color: "#fff",
              border: "none",
              borderRadius: 7,
              padding: "5px 10px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            🚀 发布
          </button>

          <button
            onClick={() => void handleExport("html")}
            title="导出可离线单文件 HTML"
            style={{
              background: "#1e293b",
              color: "#cbd5e1",
              border: "1px solid #334155",
              borderRadius: 7,
              padding: "5px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            HTML
          </button>
          <button
            onClick={() => void handleExport("zip")}
            title="导出标准 Vite+TS 源码 Zip"
            style={{
              background: "#1e293b",
              color: "#cbd5e1",
              border: "1px solid #334155",
              borderRadius: 7,
              padding: "5px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            ZIP
          </button>

          {currentSpec.mode === "multiplayer" && (
            <>
              <button
                onClick={() => {
                  const next = !splitMultiplayer;
                  setSplitMultiplayer(next);
                  void buildAndLaunch({ enableSplit: next });
                }}
                style={{
                  background: splitMultiplayer ? "#0369a1" : "#1e293b",
                  color: "#f8fafc",
                  border: "1px solid #475569",
                  borderRadius: 7,
                  padding: "5px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {splitMultiplayer ? "双窗:开" : "双窗:关"}
              </button>
              <button
                onClick={() => setShowQrModal(true)}
                disabled={!qrDataUrl}
                style={{
                  background: "#1e293b",
                  color: "#38bdf8",
                  border: "1px solid rgba(56,189,248,0.45)",
                  borderRadius: 7,
                  padding: "5px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: qrDataUrl ? "pointer" : "not-allowed",
                }}
              >
                📱 {roomInfo ? roomInfo.roomCode : "扫码"}
              </button>
            </>
          )}

          {user ? (
            <button
              onClick={async () => {
                await platformApi.logout();
                setUser(null);
                setCloudProjects([]);
              }}
              title="点击退出登录"
              style={{
                background: "rgba(52,211,153,0.14)",
                color: "#34d399",
                border: "1px solid rgba(52,211,153,0.4)",
                borderRadius: 7,
                padding: "5px 9px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              👤 {user.displayName}
            </button>
          ) : (
            <button
              onClick={() => setAuthModalOpen(true)}
              style={{
                background: "#1e293b",
                color: "#38bdf8",
                border: "1px solid rgba(56,189,248,0.45)",
                borderRadius: 7,
                padding: "5px 9px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              登录
            </button>
          )}
        </div>
      </header>

      {/* Main Split Workspace */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Left Panel */}
        <aside
          style={{
            width: 460,
            maxWidth: "46vw",
            borderRight: "1px solid #1e293b",
            display: "flex",
            flexDirection: "column",
            background: "#0b1120",
          }}
        >
          <div style={{ display: "flex", borderBottom: "1px solid #1e293b" }}>
            {(
              [
                ["agent", "🤖 AI 创作"],
                ["tuning", "数值热调"],
                ["files", "工程代码"],
                ["verify", "自检 & 资产"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setLeftTab(id)}
                style={{
                  flex: 1,
                  padding: "10px 6px",
                  background: leftTab === id ? "#1e293b" : "transparent",
                  color: leftTab === id ? "#38bdf8" : "#94a3b8",
                  border: "none",
                  borderBottom: leftTab === id ? "2px solid #38bdf8" : "2px solid transparent",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: leftTab === "agent" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
            <AgentChatPanel
              projectId={currentProject?.id || activeTemplateId}
              files={files}
              configValues={configValues}
              externalFixPrompt={externalFixPrompt}
              onConsumeExternalFix={() => setExternalFixPrompt(null)}
              onApplyFileUpdate={handleApplyAgentFileUpdate}
              onVerifyReport={setVerifyReport}
              onRequestBuild={() => void buildAndLaunch()}
              onRunL3Probe={runL3Probe}
              onBridgeReadyChange={(fn) => {
                bridgePushFileRef.current = fn;
              }}
            />
          </div>

          {leftTab === "tuning" && (
            <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>
              <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14, lineHeight: 1.5 }}>
                拖动参数滑块会实时热注入单机或 <code style={{ color: "#38bdf8" }}>workerd</code> 联机房间，并自动反向同步到本地 Bridge 目录。
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {configSchema.map((param) => {
                  const val = configValues[param.key] ?? param.defaultValue;
                  return (
                    <div
                      key={param.key}
                      style={{
                        background: "#111827",
                        border: "1px solid #1f2937",
                        borderRadius: 10,
                        padding: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                        <span style={{ fontWeight: 700 }}>{param.label}</span>
                        <span style={{ fontFamily: "monospace", color: "#38bdf8", fontWeight: 700 }}>
                          {String(val)}
                        </span>
                      </div>
                      {param.type === "number" && (
                        <input
                          type="range"
                          min={param.min ?? 0}
                          max={param.max ?? 100}
                          step={param.step ?? 1}
                          value={Number(val)}
                          onChange={(e) => handleConfigChange(param.key, Number(e.target.value))}
                          style={{ width: "100%" }}
                        />
                      )}
                      {param.description && (
                        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{param.description}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {leftTab === "files" && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #1e293b", flexWrap: "wrap" }}>
                {Object.keys(files).map((fname) => (
                  <button
                    key={fname}
                    onClick={() => setActiveFile(fname)}
                    style={{
                      padding: "4px 9px",
                      borderRadius: 6,
                      border: "1px solid #334155",
                      background: activeFile === fname ? "#0284c7" : "#111827",
                      color: activeFile === fname ? "#fff" : "#cbd5e1",
                      fontSize: 12,
                      fontFamily: "monospace",
                      cursor: "pointer",
                    }}
                  >
                    {fname}
                  </button>
                ))}
              </div>
              <textarea
                value={files[activeFile] ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setFiles((prev) => {
                    const next = { ...prev, [activeFile]: val };
                    filesRef.current = next;
                    return next;
                  });
                  bridgePushFileRef.current?.(activeFile, val);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    void buildAndLaunch();
                  }
                }}
                spellCheck={false}
                style={{
                  flex: 1,
                  width: "100%",
                  resize: "none",
                  border: "none",
                  outline: "none",
                  background: "#070b14",
                  color: "#e2e8f0",
                  padding: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.55,
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}

          {leftTab === "verify" && (
            <div style={{ padding: 14, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>L1 ~ L3 三层自检报告</div>
              {!verifyReport ? (
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  点击顶部“L1~L3”按钮，或在 AI 对话中通过 MCP <code>game_verify</code> 触发。
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                  <div
                    style={{
                      padding: 9,
                      borderRadius: 8,
                      background: verifyReport.ok ? "rgba(16,185,129,0.15)" : "rgba(244,63,94,0.15)",
                      border: `1px solid ${verifyReport.ok ? "#10b981" : "#f43f5e"}`,
                      fontWeight: 700,
                    }}
                  >
                    {verifyReport.ok ? "✅ L1~L3 全部通过，可发布/保存快照" : "❌ 发现问题，需修复"}
                  </div>
                  <div style={{ padding: 8, borderRadius: 8, background: "#111827", border: "1px solid #1f2937" }}>
                    <b>L1 编译：</b> {verifyReport.l1Compile.ok ? "PASS" : "FAIL"} ({verifyReport.l1Compile.durationMs}ms)
                  </div>
                  {verifyReport.l2Smoke && (
                    <div style={{ padding: 8, borderRadius: 8, background: "#111827", border: "1px solid #1f2937" }}>
                      <b>L2 workerd 冒烟：</b> {verifyReport.l2Smoke.ok ? "PASS" : "FAIL"} · {verifyReport.l2Smoke.ticksExecuted} ticks · 峰值 {verifyReport.l2Smoke.maxTickMs}ms
                    </div>
                  )}
                  {verifyReport.l3Runtime && (
                    <div style={{ padding: 8, borderRadius: 8, background: "#111827", border: "1px solid #1f2937" }}>
                      <b>L3 iframe 探针：</b> {verifyReport.l3Runtime.ok ? "PASS" : "FAIL"} · 像素比 {(verifyReport.l3Runtime.nonZeroPixelRatio * 100).toFixed(1)}%
                    </div>
                  )}
                </div>
              )}

              {/* Upload & On-demand AI Sprite Gen */}
              <AssetUploadAndGenPanel onAssetReady={registerAssetEntry} />

              <div style={{ fontSize: 13, fontWeight: 700 }}>当前项目资产清单 (assets.json)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {currentAssets.map((asset) => (
                  <div
                    key={asset.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "#111827",
                      border: "1px solid #1f2937",
                      padding: "6px 10px",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {asset.url && <img src={asset.url} alt={asset.id} style={{ width: 22, height: 22, objectFit: "contain" }} />}
                      <span style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{asset.id}</span>
                    </span>
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>
                      {asset.kind} · {asset.sfxPreset ?? asset.source}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 13, fontWeight: 700 }}>内置 CC0 素材库检索</div>
              <input
                value={assetQuery}
                onChange={(e) => setAssetQuery(e.target.value)}
                placeholder="输入关键词检索（如：飞船、史莱姆、star、音效）"
                style={{
                  background: "#070b14",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  padding: "7px 10px",
                  color: "#f8fafc",
                  fontSize: 12,
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {catalogResults.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      background: "#111827",
                      border: "1px solid #1f2937",
                      padding: "7px 10px",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {item.url ? (
                        <img src={item.url} alt={item.name} style={{ width: 24, height: 24 }} />
                      ) : (
                        <span style={{ fontSize: 15 }}>🔊</span>
                      )}
                      <div>
                        <div style={{ fontWeight: 700, color: "#f8fafc" }}>{item.name}</div>
                        <div style={{ color: "#64748b", fontSize: 10 }}>{item.description}</div>
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        registerAssetEntry(
                          {
                            id: item.id,
                            kind: item.kind,
                            source: item.source,
                            url: item.url,
                            sfxPreset: item.sfxPreset,
                            width: item.width,
                            height: item.height,
                          },
                          `已注册 CC0 素材 ${item.id}`,
                        )
                      }
                      style={{
                        background: "#1e293b",
                        color: "#38bdf8",
                        border: "1px solid #334155",
                        borderRadius: 6,
                        padding: "4px 8px",
                        fontWeight: 700,
                        fontSize: 11,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      + 注册
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Right Stage */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            style={{
              height: 44,
              padding: "0 14px",
              borderBottom: "1px solid #1e293b",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "#0f172a",
              fontSize: 12,
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              {(
                [
                  ["pc", "💻 PC"],
                  ["mobile-portrait", "📱 手机竖屏"],
                  ["mobile-landscape", "📱 手机横屏"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => handleDeviceSwitch(mode)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "1px solid #334155",
                    background: deviceMode === mode ? "#38bdf8" : "#1e293b",
                    color: deviceMode === mode ? "#0f172a" : "#cbd5e1",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>
                FPS: <b style={{ color: "#34d399" }}>{metrics.fps}</b> · Tick: {metrics.tick}
                {metrics.roomCode ? ` · 房 ${metrics.roomCode} (${metrics.playersCount ?? 0}人 · ${metrics.latencyMs ?? 0}ms)` : ""}
              </span>
              <button
                onClick={() => {
                  const next = !paused;
                  setPaused(next);
                  postToFrames({ channel: "aa-game-sandbox", type: "SET_PAUSED", paused: next });
                }}
                style={{
                  background: "#1e293b",
                  color: "#e2e8f0",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                {paused ? "继续" : "暂停"}
              </button>
              <button
                onClick={() => postToFrames({ channel: "aa-game-sandbox", type: "RESTART_GAME" })}
                style={{
                  background: "#1e293b",
                  color: "#e2e8f0",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                重开
              </button>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              padding: 16,
              overflow: "hidden",
              background: "radial-gradient(circle at top, #131c31, #070b14)",
            }}
          >
            <div
              style={{
                ...(splitMultiplayer && currentSpec.mode === "multiplayer"
                  ? { flex: 1, height: "100%", borderRadius: 12 }
                  : viewportBoxStyle),
                border: "2px solid #1e293b",
                overflow: "hidden",
                boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
                position: "relative",
                background: "#070b18",
              }}
            >
              <iframe
                ref={primaryFrameRef}
                src={PLAYER_ORIGIN}
                onLoad={handlePrimaryIframeLoad}
                title="AA Game Sandbox Player 1"
                sandbox="allow-scripts allow-same-origin"
                style={{ width: "100%", height: "100%", border: "none", display: "block" }}
              />
            </div>

            {splitMultiplayer && currentSpec.mode === "multiplayer" && (
              <div
                style={{
                  flex: 1,
                  height: "100%",
                  borderRadius: 12,
                  border: "2px solid #312e81",
                  overflow: "hidden",
                  boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
                  background: "#070b18",
                }}
              >
                <iframe
                  ref={secondaryFrameRef}
                  src={PLAYER_ORIGIN}
                  title="AA Game Sandbox Player 2"
                  sandbox="allow-scripts allow-same-origin"
                  style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                />
              </div>
            )}
          </div>

          {/* Bottom Console Strip */}
          <div
            style={{
              height: 112,
              borderTop: "1px solid #1e293b",
              background: "#050811",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "4px 12px",
                borderBottom: "1px solid #0f172a",
                fontSize: 11,
                color: "#64748b",
              }}
            >
              <span>运行控制台（独立安全域 {PLAYER_ORIGIN}）</span>
              {latestErrors.length > 0 && (
                <button
                  onClick={() => {
                    setLeftTab("agent");
                    setExternalFixPrompt(
                      `请修复以下游戏运行/编译错误：\n${latestErrors.map((e) => `- ${e.message}${e.stack ? `\n${e.stack.slice(0, 300)}` : ""}`).join("\n")}`,
                    );
                  }}
                  style={{
                    background: "rgba(244,63,94,0.2)",
                    color: "#fb7185",
                    border: "1px solid rgba(244,63,94,0.45)",
                    borderRadius: 6,
                    padding: "2px 8px",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  🪄 将报错发给 AI 修复 ({latestErrors.length})
                </button>
              )}
            </div>
            <div
              style={{
                flex: 1,
                padding: "5px 12px",
                overflowY: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
              }}
            >
              {logs.length === 0 ? (
                <div style={{ color: "#475569" }}>控制台就绪</div>
              ) : (
                logs.map((entry, idx) => (
                  <div
                    key={idx}
                    style={{
                      color:
                        entry.level === "error"
                          ? "#fb7185"
                          : entry.level === "warn"
                            ? "#fbbf24"
                            : "#94a3b8",
                      marginBottom: 2,
                    }}
                  >
                    [{new Date(entry.timestamp).toLocaleTimeString()}] [{entry.level.toUpperCase()}]{" "}
                    {entry.message}
                  </div>
                ))
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Modals */}
      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={(u) => {
          setUser(u);
          void refreshUserAndProjects();
        }}
      />

      <SnapshotHistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        projects={cloudProjects}
        currentProject={currentProject}
        onSelectProject={loadCloudProjectDetail}
        onRollback={handleRollbackSnapshot}
        onSaveSnapshot={handleSaveSnapshot}
      />

      <PublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        defaultTitle={currentProject?.title || currentSpec.title}
        defaultDescription={currentProject?.description || currentSpec.description}
        ensureCloudProject={ensureCloudProject}
        files={files}
        configSchema={configSchema}
        onPublished={(rel) => {
          appendLog("info", `🚀 已发布作品「${rel.title}」(/play/${rel.slug})`);
        }}
      />

      {showQrModal && (
        <div
          onClick={() => setShowQrModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.68)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0f172a",
              border: "1px solid #38bdf8",
              borderRadius: 16,
              padding: 24,
              width: 340,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>手机扫码加入同一 workerd 房间</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>
              确保手机与电脑在同一局域网，扫码后自动加载触屏虚拟摇杆并与当前电脑同场对战
            </div>
            {qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="QR Join Room"
                style={{ width: 220, height: 220, borderRadius: 12, background: "#fff", padding: 8 }}
              />
            )}
            <div
              style={{
                marginTop: 10,
                fontSize: 11,
                color: "#38bdf8",
                wordBreak: "break-all",
                fontFamily: "monospace",
              }}
            >
              {qrJoinUrl}
            </div>
            <button
              onClick={() => setShowQrModal(false)}
              style={{
                marginTop: 14,
                background: "#334155",
                color: "#f8fafc",
                border: "none",
                borderRadius: 8,
                padding: "7px 18px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
