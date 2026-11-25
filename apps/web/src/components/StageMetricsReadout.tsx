"use client";

import React, { useEffect, useState } from "react";
import type { PlayerToWorkbenchMessage, RuntimeMetrics } from "@aa-game/protocol";

/**
 * Isolated performance/metrics bar so periodic 800ms METRICS messages from the
 * sandbox iframe NEVER re-render the heavy StudioWorkbench React tree.
 */
export const StageMetricsReadout = React.memo(function StageMetricsReadout({
  frameRef,
}: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
}) {
  const [metrics, setMetrics] = useState<RuntimeMetrics>({ fps: 0, tick: 0 });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PlayerToWorkbenchMessage | undefined;
      if (!data || data.channel !== "aa-game-sandbox" || data.type !== "METRICS") return;
      if (event.source === frameRef.current?.contentWindow) {
        setMetrics(data.metrics);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef]);

  return (
    <span
      data-testid="stage-metrics"
      style={{ color: "#94a3b8", fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}
    >
      {metrics.paused ? (
        <b style={{ color: "#fbbf24" }}>⏸ 已休眠 (0 FPS)</b>
      ) : (
        <>
          FPS: <b style={{ color: "#34d399" }}>{metrics.fps}</b>
          {typeof metrics.renderMs === "number" ? ` · 渲染 ${metrics.renderMs.toFixed(2)}ms` : ""}
        </>
      )}
      {` · Tick: ${metrics.tick}`}
      {metrics.roomCode
        ? ` · 房 ${metrics.roomCode} (${metrics.playersCount ?? 0}人 · ${metrics.latencyMs ?? 0}ms)`
        : ""}
    </span>
  );
});
