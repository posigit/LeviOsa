import { mapShowsToTmdb } from "../lib/import/tmdb-mapper";

async function main() {
  const problemShows = [
    { tvShowId: 338947, name: "Titans (2018)" },
    { tvShowId: 349310, name: "Bodyguard (2018)" },
    { tvShowId: 362696, name: "The Witcher" },
    { tvShowId: 368373, name: "Sex/Life" },
    { tvShowId: 371980, name: "Severance" },
    { tvShowId: 399959, name: "Only Murders in the Building" },
    { tvShowId: 411021, name: "The Fall of the House of Usher" },
    { tvShowId: 410092, name: "Kaleidoscope (2023)" },
    { tvShowId: 366668, name: "Bridgerton" },
    { tvShowId: 361594, name: "FROM" },
    { tvShowId: 377332, name: "Power Book III: Raising Kanan" },
    { tvShowId: 348545, name: "Demon Slayer: Kimetsu no Yaiba" },
  ];

  const mappings = await mapShowsToTmdb(problemShows);

  for (const m of mappings) {
    console.log(`${m.query} -> ${m.selectedTmdbId ?? "NEEDS REVIEW"} (review: ${m.needsReview})`);
    if (m.candidates.length > 0) {
      console.log(`  top: ${m.candidates[0].title} (${m.candidates[0].year}) score=${Math.round(m.candidates[0].score)}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
