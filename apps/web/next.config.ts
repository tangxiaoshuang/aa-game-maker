import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  return {
    // Keep dev server artifacts separate from production `next build` so running
    // `pnpm build` never corrupts a live `next dev` process.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    transpilePackages: ["@aa-game/protocol", "@aa-game/templates"],
    serverExternalPackages: ["esbuild", "@aa-game/harness-core"],
    webpack: (config, { isServer }) => {
      if (isServer) {
        config.externals = Array.isArray(config.externals) ? config.externals : [];
        config.externals.push("esbuild");
      }
      return config;
    },
  };
}
