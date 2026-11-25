import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

export default nextConfig;
