import type { MetadataRoute } from "next";
import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { shows, movies } from "@/lib/schema";
import { siteUrl } from "@/lib/site";

/**
 * Detail pages are public (no session needed), so list them: the crawler
 * discovers titles from here instead of a nav that only exists after login.
 * Capped per type — newest-touched rows first — so the payload stays bounded
 * while fresh content always makes the cut.
 */
const DETAIL_CAP = 2000;

/** Static routes only when the DB is unreachable — never fail the crawl. */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/login`, changeFrequency: "monthly", priority: 0.3 },
  ];

  let detailRoutes: MetadataRoute.Sitemap = [];
  try {
    const [recentShows, recentMovies] = await Promise.all([
      db
        .select({ tmdbId: shows.tmdbId, updatedAt: shows.updatedAt })
        .from(shows)
        .orderBy(desc(shows.updatedAt))
        .limit(DETAIL_CAP),
      db
        .select({ tmdbId: movies.tmdbId, updatedAt: movies.updatedAt })
        .from(movies)
        .orderBy(desc(movies.updatedAt))
        .limit(DETAIL_CAP),
    ]);

    detailRoutes = [
      ...recentShows.map((row) => ({
        url: `${base}/show/${row.tmdbId}`,
        lastModified: row.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...recentMovies.map((row) => ({
        url: `${base}/movie/${row.tmdbId}`,
        lastModified: row.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
    ];
  } catch {
    // Cold/migrating DB — ship the static entries instead.
  }

  return [...staticRoutes, ...detailRoutes];
}
