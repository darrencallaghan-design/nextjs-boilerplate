import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
