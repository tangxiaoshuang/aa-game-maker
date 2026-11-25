"use client";

import React, { useState } from "react";
import type { UserProfile } from "@aa-game/protocol";
import { platformApi } from "@/lib/platform-api";

export function AuthModal({
  open,
  onClose,
  onAuthenticated,
}: {
  open: boolean;
  onClose: () => void;
  onAuthenticated: (user: UserProfile) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user =
        mode === "register"
          ? await platformApi.register(username.trim(), password, displayName.trim() || undefined)
          : await platformApi.login(username.trim(), password);
      onAuthenticated(user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const quickDemo = async () => {
    setError("");
    setLoading(true);
    try {
      const user = await platformApi.demoLogin();
      onAuthenticated(user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
          width: 360,
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 16,
          padding: 22,
          color: "#f8fafc",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{mode === "login" ? "登录创作者账号" : "注册创作者账号"}</h3>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 16 }}
          >
            ✕
          </button>
        </div>

        <button
          onClick={() => void quickDemo()}
          disabled={loading}
          style={{
            width: "100%",
            padding: "9px 12px",
            borderRadius: 9,
            border: "1px solid rgba(52,211,153,0.45)",
            background: "rgba(16,185,129,0.16)",
            color: "#34d399",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            marginBottom: 14,
          }}
        >
          ⚡ 一键演示创作者登录（立即可存快照 / 发布 / Remix）
        </button>

        <form onSubmit={(e) => void submit(e)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（字母/数字/下划线）"
            required
            style={{
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "8px 10px",
              color: "#f8fafc",
              fontSize: 13,
            }}
          />
          {mode === "register" && (
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="展示昵称（可选）"
              style={{
                background: "#070b14",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: "8px 10px",
                color: "#f8fafc",
                fontSize: 13,
              }}
            />
          )}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（至少 4 位）"
            required
            style={{
              background: "#070b14",
              border: "1px solid #334155",
              borderRadius: 8,
              padding: "8px 10px",
              color: "#f8fafc",
              fontSize: 13,
            }}
          />
          {error && <div style={{ color: "#fb7185", fontSize: 12 }}>{error}</div>}
          <button
            type="submit"
            disabled={loading}
            style={{
              background: "#0284c7",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "9px 12px",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {loading ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 12, color: "#94a3b8" }}>
          {mode === "login" ? (
            <>
              还没有账号？{" "}
              <button
                onClick={() => setMode("register")}
                style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontWeight: 700 }}
              >
                去注册
              </button>
            </>
          ) : (
            <>
              已有账号？{" "}
              <button
                onClick={() => setMode("login")}
                style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontWeight: 700 }}
              >
                去登录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
