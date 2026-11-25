import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AA Game Maker — AI Web Game Studio",
  description: "2D 单机与实时多人 Web 游戏创作工作台（基于 workerd V8 Isolate 权威房间沙箱）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
