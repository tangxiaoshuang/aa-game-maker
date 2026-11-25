"use client";

import React, { useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import type {
  AssetEntry,
  ConfigParam,
  ProjectDetail,
  ProjectSummary,
  ReleaseCard,
} from "@aa-game/protocol";
import { API_BASE_URL, platformApi } from "@/lib/platform-api";

const PLAYER_ORIGIN = process.env.NEXT_PUBLIC_PLAYER_ORIGIN || "http://localhost:3001";
const ROOM_API_URL = process.env.NEXT_PUBLIC_ROOM_SERVER_URL || "http://localhost:4000";

export function SnapshotHistoryModal({
  open,
  onClose,
  projects,
  currentProject,
  onSelectProject,
  onRollback,
  onSaveSnapshot,
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  currentProject: ProjectDetail | null;
  onSelectProject: (projectId: string) => Promise<void>;
  onRollback: (snapshotId: string) => Promise<void>;
  onSaveSnapshot: (summary: string) => Promise<void>;
}) {
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "92vw",
          maxHeight: "82dvh",
          overflowY: "auto",
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 16,
          padding: 20,
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>🕒 云端项目与内容寻址版本快照</h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 16, cursor: "pointer" }}
          >
            ✕
          </button>
        </div>

        {/* Save new snapshot */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="快照备注（例如：完成冲刺手感与音效调整）"
            style={{
              flex: 1,
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "7px 10px",
              color: "#f8fafc",
              fontSize: 12,
            }}
          />
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSaveSnapshot(summary.trim() || "手动保存版本快照");
                setSummary("");
              } finally {
                setBusy(false);
              }
            }}
            style={{
              background: "#10b981",
              color: "#052e16",
              border: "none",
              borderRadius: 8,
              padding: "7px 14px",
              fontWeight: 800,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            💾 保存当前快照
          </button>
        </div>

        {/* Current project snapshot list */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#38bdf8", marginBottom: 8 }}>
            当前项目快照历史（{currentProject ? currentProject.title : "尚未保存到云端"}）
          </div>
          {!currentProject || currentProject.snapshots.length === 0 ? (
            <div style={{ fontSize: 12, color: "#64748b" }}>点击上方“保存当前快照”即可在 PostgreSQL 创建首个内容寻址快照。</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {currentProject.snapshots.map((snp) => {
                const isCurrent = snp.id === currentProject.currentSnapshotId;
                return (
                  <div
                    key={snp.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: isCurrent ? "rgba(56,189,248,0.12)" : "#111827",
                      border: `1px solid ${isCurrent ? "#38bdf8" : "#1f2937"}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {snp.commitSummary} {isCurrent && <span style={{ color: "#34d399" }}>· 当前版本</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                        {snp.id} · {snp.fileCount} 文件 · {new Date(snp.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {!isCurrent && (
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await onRollback(snp.id);
                          } finally {
                            setBusy(false);
                          }
                        }}
                        style={{
                          background: "#1e293b",
                          color: "#fbbf24",
                          border: "1px solid rgba(251,191,36,0.45)",
                          borderRadius: 6,
                          padding: "4px 10px",
                          fontWeight: 700,
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        ⏪ 回滚
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* My Cloud Projects */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 8 }}>
            我的云端项目列表 ({projects.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {projects.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#111827",
                  border: "1px solid #1f2937",
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 12,
                }}
              >
                <div>
                  <span style={{ fontWeight: 700 }}>{p.title}</span>{" "}
                  <span style={{ fontSize: 11, color: "#64748b" }}>
                    ({p.mode === "multiplayer" ? "联机" : "单机"})
                  </span>
                </div>
                <button
                  disabled={busy || p.id === currentProject?.id}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onSelectProject(p.id);
                      onClose();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  style={{
                    background: p.id === currentProject?.id ? "#1e293b" : "#0284c7",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: p.id === currentProject?.id ? "default" : "pointer",
                  }}
                >
                  {p.id === currentProject?.id ? "已打开" : "切换打开"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PublishModal({
  open,
  onClose,
  defaultTitle,
  defaultDescription,
  ensureCloudProject,
  files,
  configSchema,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  defaultTitle: string;
  defaultDescription: string;
  ensureCloudProject: () => Promise<ProjectDetail>;
  files: Record<string, string>;
  configSchema: ConfigParam[];
  onPublished: (release: ReleaseCard) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [published, setPublished] = useState<{
    release: ReleaseCard;
    playPath: string;
    qrDataUrl: string;
    mobileUrl: string;
  } | null>(null);

  React.useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setDescription(defaultDescription);
      setError("");
      setPublished(null);
    }
  }, [open, defaultTitle, defaultDescription]);

  if (!open) return null;

  const handlePublish = async () => {
    setBusy(true);
    setError("");
    try {
      const proj = await ensureCloudProject();
      const res = await platformApi.publishProject(proj.id, {
        title: title.trim() || proj.title,
        description: description.trim(),
        isPublic,
        files,
        configSchema,
      });

      const lanHost = res.lanIp || window.location.hostname;
      const playerPort = new URL(PLAYER_ORIGIN).port || "3001";
      const apiPort = new URL(API_BASE_URL).port || "4002";
      const roomPort = new URL(ROOM_API_URL).port || "4000";
      const mobileUrl = `http://${lanHost}:${playerPort}/?release=${encodeURIComponent(res.release.slug)}&api=${encodeURIComponent(`http://${lanHost}:${apiPort}`)}&roomApi=${encodeURIComponent(`http://${lanHost}:${roomPort}`)}`;
      const qrDataUrl = await QRCode.toDataURL(mobileUrl, { width: 200, margin: 1 });

      setPublished({
        release: res.release,
        playPath: `/play/${encodeURIComponent(res.release.slug)}`,
        qrDataUrl,
        mobileUrl,
      });
      onPublished(res.release);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "92vw",
          background: "#0f172a",
          border: "1px solid #38bdf8",
          borderRadius: 16,
          padding: 22,
          color: "#f8fafc",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>🚀 一键发布到 RustFS S3 & 社区广场</h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 16, cursor: "pointer" }}
          >
            ✕
          </button>
        </div>

        {!published ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="作品名称"
              style={{
                background: "#070b14",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "8px 10px",
                color: "#f8fafc",
                fontSize: 13,
              }}
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="玩法简介与操作说明..."
              rows={3}
              style={{
                background: "#070b14",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "8px 10px",
                color: "#f8fafc",
                fontSize: 12,
                resize: "none",
              }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#cbd5e1" }}>
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              公开上架到社区游戏广场（允许他人试玩、点赞与一键 Fork/Remix）
            </label>
            {error && <div style={{ color: "#fb7185", fontSize: 12 }}>{error}</div>}
            <button
              disabled={busy}
              onClick={() => void handlePublish()}
              style={{
                background: "#10b981",
                color: "#052e16",
                border: "none",
                borderRadius: 8,
                padding: "9px 14px",
                fontWeight: 800,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {busy ? "正在冻结快照并打包上传..." : "确认发布"}
            </button>
          </div>
        ) : (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
            <div style={{ color: "#34d399", fontWeight: 800, fontSize: 15 }}>✅ 发布成功！</div>
            <img
              src={published.qrDataUrl}
              alt="Published Game QR"
              style={{ width: 190, height: 190, borderRadius: 10, background: "#fff", padding: 6 }}
            />
            <div style={{ fontSize: 11, color: "#94a3b8" }}>手机扫码直玩（联机游戏支持扫码建房/输入房间码同玩）</div>
            <div style={{ display: "flex", gap: 8, width: "100%", marginTop: 4 }}>
              <Link
                href={published.playPath}
                style={{
                  flex: 1,
                  textDecoration: "none",
                  background: "#0284c7",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                ▶ 打开独立游玩页
              </Link>
              <Link
                href="/gallery"
                style={{
                  flex: 1,
                  textDecoration: "none",
                  background: "#1e293b",
                  color: "#38bdf8",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                🕹️ 去游戏广场查看
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AssetUploadAndGenPanel({
  onAssetReady,
}: {
  onAssetReady: (entry: AssetEntry, note: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [uploading, setUploading] = useState(false);

  const [genPrompt, setGenPrompt] = useState("");
  const [genStyle, setGenStyle] = useState<"neon" | "pixel" | "cartoon">("neon");
  const [removeBg, setRemoveBg] = useState(true);
  const [imgApiKey, setImgApiKey] = useState("");
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatusMsg("");
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await platformApi.uploadAsset({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: dataUrl,
        assetId: targetId.trim() || undefined,
      });
      onAssetReady(res.entry, `已上传至 ${res.storage.toUpperCase()} 并注册为 ${res.entry.id}`);
      setStatusMsg(`✅ 上传成功 (${res.storage}): ${res.entry.id}`);
      setTargetId("");
    } catch (err) {
      setStatusMsg(`❌ 上传失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleGenerate = async () => {
    if (!genPrompt.trim()) return;
    setGenerating(true);
    setStatusMsg("");
    try {
      const res = await platformApi.generateSprite({
        prompt: genPrompt.trim(),
        assetId: targetId.trim() || undefined,
        style: genStyle,
        removeBg,
        apiKey: imgApiKey.trim() || undefined,
      });
      onAssetReady(
        res.entry,
        `已生成透明精灵图 ${res.entry.id} (${res.usedExternalApi ? "外部生图 API" : "内置矢量去背"} · ${res.storage.toUpperCase()})`,
      );
      setStatusMsg(`✅ 生成并存入 ${res.storage.toUpperCase()}: ${res.entry.id}`);
      setGenPrompt("");
    } catch (err) {
      setStatusMsg(`❌ 生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Custom S3 Asset Upload */}
      <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 10, padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>📤 上传自定义图片 / 音频（RustFS S3 热替换）</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="目标 Asset ID（留空自动生成，填已有 ID 可一键换皮）"
            style={{
              flex: 1,
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "5px 8px",
              color: "#f8fafc",
              fontSize: 11,
            }}
          />
        </div>
        <label
          style={{
            display: "block",
            textAlign: "center",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px dashed #38bdf8",
            background: "rgba(56,189,248,0.08)",
            color: "#38bdf8",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {uploading ? "上传至 RustFS S3 中..." : "点击选择图片 (PNG/SVG/WebP) 或音效 (MP3/WAV) 上传"}
          <input type="file" accept="image/*,audio/*" onChange={(e) => void handleFileChange(e)} style={{ display: "none" }} />
        </label>
      </div>

      {/* On-Demand AI Sprite Generation + Transparent BG */}
      <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 10, padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>✨ 按需生成 2D 精灵图（支持自动去背）</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            value={genPrompt}
            onChange={(e) => setGenPrompt(e.target.value)}
            placeholder="描述精灵图（如：赛博机甲BOSS / 火焰史莱姆）"
            style={{
              flex: 1,
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "5px 8px",
              color: "#f8fafc",
              fontSize: 11,
            }}
          />
          <select
            value={genStyle}
            onChange={(e) => setGenStyle(e.target.value as typeof genStyle)}
            style={{
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "4px 6px",
              color: "#f8fafc",
              fontSize: 11,
            }}
          >
            <option value="neon">霓虹风</option>
            <option value="pixel">像素风</option>
            <option value="cartoon">卡通风</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input
            type="password"
            value={imgApiKey}
            onChange={(e) => setImgApiKey(e.target.value)}
            placeholder="可选 OpenAI 生图 Key（留空走内置秒级矢量精灵合成）"
            style={{
              flex: 1,
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "5px 8px",
              color: "#f8fafc",
              fontSize: 11,
            }}
          />
          <label style={{ fontSize: 11, color: "#cbd5e1", display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} />
            去背
          </label>
        </div>
        <button
          disabled={generating || !genPrompt.trim()}
          onClick={() => void handleGenerate()}
          style={{
            width: "100%",
            background: "#7c3aed",
            color: "#fff",
            border: "none",
            borderRadius: 7,
            padding: "6px 10px",
            fontWeight: 700,
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {generating ? "生成并上传 RustFS 中..." : "✨ 生成并注册到 assets.json"}
        </button>
      </div>

      {statusMsg && <div style={{ fontSize: 11, color: statusMsg.startsWith("❌") ? "#fb7185" : "#34d399" }}>{statusMsg}</div>}
    </div>
  );
}
