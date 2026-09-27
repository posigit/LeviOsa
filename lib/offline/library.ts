/**
 * Library presentation order — one pure pass shared by /library and the
 * download settings sheet so both show the same thing.
 *
 * `getAllSync()` returns records in download order (newest first), which
 * scatters a show's episodes among other titles. These helpers regroup:
 *   - episodes by show, in season/episode order (a paused/failed row keeps
 *     its slot so the gap is visible instead of being sorted away),
 *   - shows by their newest download (the show you just saved stays on top),
 *   - movies as their own single-row groups, newest download first.
 *
 * No I/O: records in, structure out — safe to import from a test script.
 */
import type { DownloadRecord } from "@/lib/offline/store";

export type LibraryRow = {
  record: DownloadRecord;
  /** "Season N" label shown above this row when a show spans seasons. */
  seasonLabel: string | null;
};

export type LibraryGroup = {
  /** React key: `show:<tmdbId>` for episodes, the record key for a movie. */
  id: string;
  /** Section header (the show name). Movies are null — their row shows it. */
  header: string | null;
  rows: LibraryRow[];
};

/** Show name = the title before the " — " download rows are named with. */
export function showNameOf(title: string): string {
  const cut = title.indexOf(" — ");
  return (cut > 0 ? title.slice(0, cut) : title).trim();
}

/** Season then episode — stable, so ties keep download order. */
export function compareEpisodeRecords(
  a: DownloadRecord,
  b: DownloadRecord
): number {
  return (
    (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)
  );
}

function newestDownloadedAt(group: LibraryGroup): number {
  let newest = 0;
  for (const row of group.rows) {
    if (row.record.downloadedAt > newest) newest = row.record.downloadedAt;
  }
  return newest;
}

/**
 * Group and sort records for display. Pure: the input array is never
 * mutated and the same input always yields the same order.
 */
export function orderLibraryGroups(records: DownloadRecord[]): LibraryGroup[] {
  const shows = new Map<number, DownloadRecord[]>();
  const groups: LibraryGroup[] = [];

  for (const record of records) {
    if (record.type === "movie") {
      groups.push({
        id: record.key,
        header: null,
        rows: [{ record, seasonLabel: null }],
      });
      continue;
    }
    const list = shows.get(record.tmdbId);
    if (list) list.push(record);
    else shows.set(record.tmdbId, [record]);
  }

  for (const [tmdbId, list] of shows) {
    const ordered = [...list].sort(compareEpisodeRecords);
    const seasons = new Set(ordered.map((r) => r.season ?? 0));
    const labelSeasons = seasons.size > 1;
    let lastSeason: number | null = null;
    const rows: LibraryRow[] = ordered.map((record) => {
      const season = record.season ?? 0;
      const seasonLabel =
        labelSeasons && season !== lastSeason ? `Season ${season}` : null;
      lastSeason = season;
      return { record, seasonLabel };
    });
    groups.push({
      id: `show:${tmdbId}`,
      header: showNameOf(rows[0]!.record.title),
      rows,
    });
  }

  return groups.sort((a, b) => newestDownloadedAt(b) - newestDownloadedAt(a));
}

/**
 * The next finished episode of the same show, in season/episode order.
 * Returns null for movies, for a show whose last download this is, and when
 * nothing later is `done` (a gap must not skip ahead to a stale row).
 */
export function nextDownloadedEpisode(
  records: DownloadRecord[],
  current: DownloadRecord
): DownloadRecord | null {
  if (current.type === "movie") return null;
  const later = records
    .filter(
      (r) =>
        r.type === "episode" &&
        r.tmdbId === current.tmdbId &&
        r.state === "done" &&
        compareEpisodeRecords(r, current) > 0
    )
    .sort(compareEpisodeRecords);
  return later[0] ?? null;
}
