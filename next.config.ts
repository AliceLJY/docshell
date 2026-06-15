import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Safari from caching stale JS bundles during development
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
