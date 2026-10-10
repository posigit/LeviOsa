import { vidsrcShResolve } from "@/lib/vidsrc-sh";

async function main() {
  // Movie: Inception (tmdb 27205)
  const m = await vidsrcShResolve({ type: "movie", id: 27205 });
  console.log("movie:", m.title, "| urls:", m.urls.length);
  console.log("movie url[0]:", m.urls[0]?.slice(0, 110));
  if (m.urls.length === 0) throw new Error("movie: no urls");

  // TV: Breaking Bad S1E1 (tmdb 1396)
  const t = await vidsrcShResolve({ type: "tv", id: 1396, season: 1, episode: 1 });
  console.log("tv:", t.title, "| urls:", t.urls.length);
  console.log("tv url[0]:", t.urls[0]?.slice(0, 110));
  if (t.urls.length === 0) throw new Error("tv: no urls");

  // Second movie call (exercises per-window key cache path on repeat use)
  const m2 = await vidsrcShResolve({ type: "movie", id: 27205 });
  console.log("movie repeat urls:", m2.urls.length);
  if (m2.urls.length === 0) throw new Error("repeat: no urls");
  console.log("E2E OK");
}

main().catch((e) => {
  console.error("E2E FAIL:", e);
  process.exit(1);
});
