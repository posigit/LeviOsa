import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Auth-gated surfaces — a crawler only ever sees the login redirect,
        // so keep the crawl budget on the public detail pages.
        disallow: [
          "/api/",
          "/profile",
          "/calendar",
          "/library",
          "/import",
          "/person/",
          "/movie/year/",
          "/movie/decade/",
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
