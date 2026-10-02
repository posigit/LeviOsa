/**
 * Canonical origin for absolute URLs — metadataBase, Open Graph images,
 * robots.txt and the sitemap all build from this so shares/scraps resolve to
 * one host.
 *
 * Order: explicit app URL → NextAuth's public AUTH_URL (production deploys
 * set only that) → Vercel's generated host → local dev.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
