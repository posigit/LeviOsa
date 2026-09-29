import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  allowedDevOrigins: [
    "soft-naturely.outray.app",
    "*.outray.app",
    "*.trycloudflare.com",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
      {
        protocol: "https",
        hostname: "i.ytimg.com",
        pathname: "/vi/**",
      },
      // Sticker rail (Fanart character art / clearart) — served through the
      // optimizer so transparent PNGs ship as ~8KB AVIF instead of ~300KB each.
      {
        protocol: "https",
        hostname: "assets.fanart.tv",
        pathname: "/fanart/**",
      },
    ],
    // Smaller bytes on poster-heavy grids (AVIF first, WebP fallback).
    formats: ["image/avif", "image/webp"],
    // TMDB posters are immutable per path — cache resized output a full day.
    minimumCacheTTL: 86400,
  },
  // lucide-react is fully tree-shaken instead of bundling every icon.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      // Profile pic / local icons: browser may keep for a year (change filename to bust)
      {
        source: "/avatars/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/manifest.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        source: "/icons/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
