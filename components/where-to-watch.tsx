import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { providerLogoUrl, type WatchProvidersResult } from "@/lib/tmdb";
import type { MotnWatch } from "@/lib/motn";

type Provider = {
  key: string;
  name: string;
  logo: string | null;
  href?: string;
};

/**
 * Where to watch — one row of service marks, nothing else.
 *
 * Quality/price/expiry chips were here once; nobody picks a service by 4K vs
 * HD, so we keep the mark, the name and the deep link and drop the rest.
 * Movie of the Night carries the deep links; when it has nothing for this
 * show (or the key/region is unavailable) we fall back to TMDB's JustWatch
 * feed and hang the JustWatch browse link off the whole card instead.
 */
export function WhereToWatch({
  watch,
  providers,
}: {
  watch?: MotnWatch | null;
  providers?: WatchProvidersResult | null;
}) {
  const items: Provider[] = [];
  let browseHref: string | undefined;
  let region: string | null = null;

  if (watch && watch.options.length > 0) {
    const seen = new Set<string>();
    for (const o of watch.options) {
      const key = o.serviceId || o.serviceName;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        key,
        name: o.serviceName || o.serviceId,
        logo: o.logo,
        href: o.link,
      });
    }
    region = watch.country.toUpperCase();
  } else if (providers) {
    const seen = new Set<number>();
    const push = (list: WatchProvidersResult["flatrate"]) => {
      for (const p of list) {
        if (seen.has(p.provider_id)) continue;
        seen.add(p.provider_id);
        items.push({
          key: String(p.provider_id),
          name: p.provider_name,
          logo: providerLogoUrl(p.logo_path),
        });
      }
    };
    push(providers.flatrate);
    push(providers.rent);
    push(providers.buy);
    browseHref = providers.link;
    region = (process.env.NEXT_PUBLIC_WATCH_REGION ||
      process.env.WATCH_REGION ||
      "NG").toUpperCase();
  }

  if (items.length === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="text-[22px] font-extrabold tracking-tight text-white">
          Where to watch
        </h2>
        {region && (
          <span className="text-xs font-semibold text-white/40">{region}</span>
        )}
      </div>

      <div className="glass-panel rounded-3xl p-4">
        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const inner = (
              <>
                {item.logo ? (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    <Image
                      src={item.logo}
                      alt=""
                      width={28}
                      height={28}
                      className="max-h-7 w-auto max-w-full object-contain"
                      unoptimized
                    />
                  </span>
                ) : null}
                <span className="max-w-[8rem] truncate text-xs font-semibold text-white">
                  {item.name}
                </span>
              </>
            );

            return item.href ? (
              <a
                key={item.key}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-2xl bg-black/35 px-2.5 py-2 ring-1 ring-white/[0.08] transition hover:bg-black/55 active:scale-[0.98]"
              >
                {inner}
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-white/35" />
              </a>
            ) : (
              <span
                key={item.key}
                className="flex items-center gap-2 rounded-2xl bg-black/35 px-2.5 py-2 ring-1 ring-white/[0.08]"
              >
                {inner}
              </span>
            );
          })}
        </div>

        {browseHref && (
          <a
            href={browseHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
          >
            See all on JustWatch
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </section>
  );
}
