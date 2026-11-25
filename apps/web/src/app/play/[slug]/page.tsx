"use client";

import React, { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import type { ReleaseCard, UserProfile } from "@aa-game/protocol";
import { API_BASE_URL, platformApi } from "@/lib/platform-api";
import { AuthModal } from "@/components/AuthModal";

const PLAYER_ORIGIN = process.env.NEXT_PUBLIC_PLAYER_ORIGIN || "http://localhost:3001";
const ROOM_API_URL = process.env.NEXT_PUBLIC_ROOM_SERVER_URL || "http://localhost:4000";

export default function PlayReleasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const [release, setRelease] = useState<ReleaseCard | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState("");
  const [qrLink, setQrLink] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [meRes, healthRes, relRes] = await Promise.all([
          platformApi.me().catch(() => ({ user: null })),
          platformApi.health().catch(() => ({ ok: false, dbOk: false, s3Ok: false, lanIp: "127.0.0.1" })),
          platformApi.getRelease(slug),
        ]);
        if (!active) return;
        setUser(meRes.user);
        setRelease(relRes.release);

        const lanHost = healthRes.lanIp || window.location.hostname;
        const playerPort = new URL(PLAYER_ORIGIN).port || "3001";
        const apiPort = new URL(API_BASE_URL).port || "4002";
        const roomPort = new URL(ROOM_API_URL).port || "4000";
        const mobileUrl = `http://${lanHost}:${playerPort}/?release=${encodeURIComponent(slug)}&api=${encodeURIComponent(`http://${lanHost}:${apiPort}`)}&roomApi=${encodeURIComponent(`http://${lanHost}:${roomPort}`)}`;
        setQrLink(mobileUrl);
        setQrUrl(await QRCode.toDataURL(mobileUrl, { width: 220, margin: 1 }));
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [slug]);

  const handleLike = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    const res = await platformApi.toggleLike(slug);
    setRelease(res.release);
  };

  const handleRemix = async () => {
    if (!user) {
      setAuthOpen(true);
      return;
    }
    const res = await platformApi.remixRelease(slug);
    router.push(`/?project=${encodeURIComponent(res.project.id)}`);
  };

  const iframeSrc = `${PLAYER_ORIGIN}/?release=${encodeURIComponent(slug)}&api=${encodeURIComponent(API_BASE_URL)}&roomApi=${encodeURIComponent(ROOM_API_URL)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#070b14", color: "#f8fafc" }}>
      <header
        style={{
          height: 54,
          padding: "0 16px",
          borderBottom: "1px solid #1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#0f172a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/gallery" style={{ color: "#38bdf8", textDecoration: "none", fontSize: 13, fontWeight: 700 }}>
            ← 游戏广场
          </Link>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{release?.title ?? slug}</span>
          {release && (
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              作者：{release.authorName} · ▶ {release.playCount}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {release && (
            <button
              onClick={() => void handleLike()}
              style={{
                background: release.likedByMe ? "rgba(244,63,94,0.22)" : "#1e293b",
                color: release.likedByMe ? "#fb7185" : "#e2e8f0",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "6px 10px",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {release.likedByMe ? "♥" : "♡"} {release.likeCount}
            </button>
          )}
          <button
            onClick={() => setShowQr(true)}
            style={{
              background: "#1e293b",
              color: "#38bdf8",
              border: "1px solid rgba(56,189,248,0.45)",
              borderRadius: 8,
              padding: "6px 10px",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            📱 手机扫码玩
          </button>
          <button
            onClick={() => void handleRemix()}
            style={{
              background: "#0284c7",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            🔀 一键 Remix 魔改
          </button>
        </div>
      </header>

      <main style={{ flex: 1, position: "relative" }}>
        {error ? (
          <div style={{ padding: 40, textAlign: "center", color: "#fb7185" }}>加载失败：{error}</div>
        ) : (
          <iframe
            src={iframeSrc}
            title={release?.title || slug}
            sandbox="allow-scripts allow-same-origin"
            style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          />
        )}
      </main>

      {showQr && (
        <div
          onClick={() => setShowQr(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
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
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>手机扫码立即游玩</div>
            {qrUrl && <img src={qrUrl} alt="Play QR" style={{ width: 220, height: 220, borderRadius: 12, background: "#fff", padding: 8 }} />}
            <div style={{ marginTop: 10, fontSize: 11, color: "#38bdf8", wordBreak: "break-all", fontFamily: "monospace" }}>
              {qrLink}
            </div>
            <button
              onClick={() => setShowQr(false)}
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

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={(u) => setUser(u)}
      />
    </div>
  );
}
