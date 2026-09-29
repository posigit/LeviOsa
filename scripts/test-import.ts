import { db } from "../lib/db";
import { parseGdprExport } from "../lib/import/parser";
import { importLists, importMovies, importShows } from "../lib/import/importer";
import { mapMoviesToTmdb, mapShowsToTmdb } from "../lib/import/tmdb-mapper";
import path from "path";

async function main() {
  // Get first user
  const user = await db.query.users.findFirst();
  if (!user) {
    console.error("No user found");
    process.exit(1);
  }

  console.log(`Testing import for user: ${user.username}`);

  const data = await parseGdprExport(path.join(process.cwd(), "..", "gdpr-data"));

  // Test with first 5 shows and 5 movies
  const testShows = new Map(Array.from(data.shows.entries()).slice(0, 5));
  const testMovies = data.movies.slice(0, 5);
  const testData = {
    ...data,
    shows: testShows,
    movies: testMovies,
    episodeWatches: data.episodeWatches.filter((w) => testShows.has(w.tvShowId)),
    episodeReactions: data.episodeReactions.filter((r) =>
      Array.from(testShows.values()).some((s) => s.name === r.tvShowName)
    ),
    movieReactions: data.movieReactions.filter((r) =>
      testMovies.some((m) => m.uuid === r.movieUuid)
    ),
    lists: [],
  };

  console.log(`Mapping ${testShows.size} shows and ${testMovies.length} movies...`);

  const showMappings = await mapShowsToTmdb(
    Array.from(testShows.values()).map((s) => ({ tvShowId: s.tvShowId, name: s.name }))
  );
  const movieMappings = await mapMoviesToTmdb(
    testMovies.map((m) => ({ name: m.name, releaseDate: m.releaseDate }))
  );

  console.log("Show mappings:", showMappings.map((m) => ({ name: m.query, selected: m.selectedTmdbId, needsReview: m.needsReview })));
  console.log("Movie mappings:", movieMappings.map((m) => ({ name: m.query, selected: m.selectedTmdbId, needsReview: m.needsReview })));

  await importShows(user.id, showMappings, testData);
  await importMovies(user.id, movieMappings, testData);
  await importLists(user.id, showMappings, movieMappings, testData);

  console.log("Test import complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
