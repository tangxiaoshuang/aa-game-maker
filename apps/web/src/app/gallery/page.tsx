"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReleaseCard, UserProfile } from "@aa-game/protocol";
import { platformApi } from "@/lib/platform-api";
import { AuthModal } from "@/components/AuthModal";

export default function GalleryPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [releases, setReleases] = useState<ReleaseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [modeFilter, setModeFilter] = useState<"all" | "singleplayer" | "multiplayer">("all");
  const [sort, setSort] = useState<"latest" | "popular" | "likes">("latest");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [meRes, relRes] = await Promise.all([
        platformApi.me().catch(() => ({ user: null })),
        platformApi.listReleases({ mode: modeFilter, q: search.trim(), sort }),
      ]);
      setUser(meRes.user);
      setReleases(relRes.releases);
    } catch (err) {
      setError(`无法连接社区 API (:4002): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [modeFilter, search, sort]);

  useEffect(() => {
    const t = setTimeout(() => void loadData(), 150);
    return () => clearTimeout(t);
  }, [loadData]);

  const handleLike = async (slug: string) => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    try {
      const res = await platformApi.toggleLike(slug);
      setReleases((prev) => prev.map((r) => (r.slug === slug ? res.release : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemix = async (slug: string) => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    try {
      const res = await platformApi.remixRelease(slug);
      router.push(`/?project=${encodeURIComponent(res.project.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ minHeight: "100dvh", background: "#090d16", color: "#e2e8f0" }}>
      <header
        style={{
          height: 58,
          padding: "0 24px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#0f172a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Link href="/" style={{ textDecoration: "none", fontWeight: 800, fontSize: 16, color: "#38bdf8" }}>
            AA Game Maker
          </Link>
          <span style={{ color: "#475569" }}>/</span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>🕹️ 社区游戏广场</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link
            href="/"
            style={{
              textDecoration: "none",
              background: "#0284c7",
              color: "#fff",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            + 打开创作工作台
          </Link>
          {user ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ color: "#34d399", fontWeight: 700 }}>👤 {user.displayName}</span>
              <button
                onClick={async () => {
                  await platformApi.logout();
                  setUser(null);
                  void loadData();
                }}
                style={{
                  background: "#1e293b",
                  color: "#cbd5e1",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "4px 9px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                退出
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAuthOpen(true)}
              style={{
                background: "#1e293b",
                color: "#38bdf8",
                border: "1px solid rgba(56,189,248,0.45)",
                borderRadius: 8,
                padding: "6px 12px",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              登录 / 注册
            </button>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 20px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {(
              [
                ["all", "全部作品"],
                ["singleplayer", "2D 单机"],
                ["multiplayer", "2D 实时联机"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setModeFilter(m)}
                style={{
                  padding: "7px 14px",
                  borderRadius: 999,
                  border: "1px solid #334155",
                  background: modeFilter === m ? "#38bdf8" : "#111827",
                  color: modeFilter === m ? "#0f172a" : "#cbd5e1",
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索游戏标题或玩法..."
              style={{
                background: "#111827",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "7px 12px",
                color: "#f8fafc",
                fontSize: 13,
                width: 220,
              }}
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              style={{
                background: "#111827",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "7px 10px",
                color: "#f8fafc",
                fontSize: 13,
              }}
            >
              <option value="latest">最新发布</option>
              <option value="popular">最多游玩</option>
              <option value="likes">最多点赞</option>
            </select>
          </div>
        </div>

        {error && (
          <div
            style={{
              marginBottom: 18,
              padding: 12,
              borderRadius: 10,
              background: "rgba(244,63,94,0.14)",
              border: "1px solid #f43f5e",
              color: "#fda4af",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>加载社区游戏广场中...</div>
        ) : releases.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
            暂无符合条件的公开作品，快去工作台发布第一款吧！
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
              gap: 18,
            }}
          >
            {releases.map((rel) => (
              <div
                key={rel.id}
                style={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: 14,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  style={{
                    height: 132,
                    background:
                      rel.mode === "multiplayer"
                        ? "linear-gradient(135deg, #0f172a, #064e3b)"
                        : "linear-gradient(135deg, #0f172a, #1e3a8a)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    padding: 14,
                    position: "relative",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        padding: "3px 8px",
                        borderRadius: 999,
                        background:
                          rel.mode === "multiplayer" ? "rgba(52,211,153,0.22)" : "rgba(56,189,248,0.22)",
                        color: rel.mode === "multiplayer" ? "#34d399" : "#38bdf8",
                      }}
                    >
                      {rel.mode === "multiplayer" ? "⚡ 2D 实时联机 (workerd)" : "🎮 2D 单机"}
                    </span>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>
                      {rel.orientation === "portrait" ? "📱 竖屏" : rel.orientation === "landscape" ? "💻 横屏" : "📐 自适应"}
                    </span>
                  </div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#f8fafc" }}>{rel.title}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>作者：{rel.authorName}</div>
                  </div>
                </div>

                <div style={{ padding: 14, flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.55, flex: 1 }}>
                    {rel.description || "由 AA Game Maker 创作的 Web 2D 游戏"}
                  </div>

                  <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94a3b8" }}>
                    <span>▶ {rel.playCount} 游玩</span>
                    <span>♥ {rel.likeCount} 点赞</span>
                    <span>🔀 {rel.remixCount} Remix</span>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <Link
                      href={`/play/${encodeURIComponent(rel.slug)}`}
                      style={{
                        flex: 1,
                        textAlign: "center",
                        textDecoration: "none",
                        background: "#10b981",
                        color: "#052e16",
                        borderRadius: 8,
                        padding: "7px 10px",
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      ▶ 立即游玩
                    </Link>
                    <button
                      onClick={() => void handleLike(rel.slug)}
                      style={{
                        background: rel.likedByMe ? "rgba(244,63,94,0.2)" : "#1e293b",
                        color: rel.likedByMe ? "#fb7185" : "#e2e8f0",
                        border: `1px solid ${rel.likedByMe ? "#f43f5e" : "#334155"}`,
                        borderRadius: 8,
                        padding: "7px 10px",
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {rel.likedByMe ? "♥ 已赞" : "♡ 赞"}
                    </button>
                    <button
                      onClick={() => void handleRemix(rel.slug)}
                      style={{
                        background: "#1e293b",
                        color: "#38bdf8",
                        border: "1px solid rgba(56,189,248,0.45)",
                        borderRadius: 8,
                        padding: "7px 10px",
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      🔀 Remix
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={(u) => {
          setUser(u);
          void loadData();
        }}
      />
    </div>
  );
}
