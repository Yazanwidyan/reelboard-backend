import { all, run } from "../db/index.js";
import { tmdbGet } from "./tmdb.js";

// Movies' TMDB keywords ("car race", "le mans", "rivalry") — what a film is
// about, more precisely than its genres. Fetched from TMDB the first time
// they're needed, then kept in the movie_keywords table. How many kept
// movies carry each keyword is counted too, so a rare one ("le mans") can
// count for more than a common one ("murder").

// Kept this long, then fetched again (TMDB's lists grow).
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
// TMDB calls at once.
const BATCH = 8;
// Tags about the film's production, not its story.
const IGNORED = new Set([
  "duringcreditsstinger",
  "aftercreditsstinger",
  "woman director",
  "based on novel or book",
  "based on comic",
  "based on true story",
  "biography",
  "sequel",
  "remake",
  "3d",
  "imax",
  "live action remake",
  "anime",
]);

// TMDB's keywords as [{ id, name }], lower case, without the ignored ones.
const clean = (keywords) => {
  const seen = new Set();
  return keywords
    .map((keyword) => ({ id: keyword.id ?? null, name: String(keyword.name).toLowerCase().trim() }))
    .filter((keyword) => keyword.name && !IGNORED.has(keyword.name) && !seen.has(keyword.name) && seen.add(keyword.name));
};
// A kept row: [{ id, name }] (older rows were names only).
const parse = (json) =>
  JSON.parse(json).map((keyword) => (typeof keyword === "string" ? { id: null, name: keyword } : keyword));

// How many kept movies have each keyword — read once, then kept up to date.
let stats = null; // { total, counts: Map(keyword → n), known: Set(movieId) }
const getStats = () => {
  if (!stats) {
    stats = { total: 0, counts: new Map(), known: new Set() };
    all("SELECT movie_id, keywords FROM movie_keywords").forEach((row) => count(row.movie_id, parse(row.keywords)));
  }
  return stats;
};
const count = (movieId, keywords) => {
  if (stats.known.has(movieId)) return;
  stats.known.add(movieId);
  stats.total += 1;
  keywords.forEach(({ name }) => stats.counts.set(name, (stats.counts.get(name) ?? 0) + 1));
};

// How telling a keyword is: rarer is more (an inverse document frequency
// over every kept movie). Before many are kept, every keyword counts about
// the same.
export const keywordWeight = (keyword) => {
  const { total, counts } = getStats();
  return Math.log(1 + (total + 1) / ((counts.get(keyword) ?? 0) + 1));
};

// Map(movieId → [{ id, name }]) for the ids given — from the table, else TMDB.
// A movie TMDB can't be asked about right now just has none, this time.
export const getKeywords = async (ids) => {
  getStats();
  const unique = [...new Set(ids.map(String))];
  const found = new Map();
  if (unique.length === 0) return found;
  const fresh = Date.now() - KEEP_MS;
  const rows = all(
    `SELECT movie_id, keywords, fetched_at FROM movie_keywords WHERE movie_id IN (${unique.map(() => "?").join(",")})`,
    unique,
  );
  rows.forEach((row) => {
    if (row.fetched_at >= fresh) found.set(row.movie_id, parse(row.keywords));
  });

  const missing = unique.filter((id) => !found.has(id));
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map((id) => tmdbGet(`/movie/${id}/keywords`)));
    results.forEach((result, j) => {
      const id = batch[j];
      if (result.status !== "fulfilled") {
        found.set(id, []);
        return;
      }
      const keywords = clean(result.value?.keywords ?? []);
      found.set(id, keywords);
      run(
        "INSERT INTO movie_keywords (movie_id, keywords, fetched_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(movie_id) DO UPDATE SET keywords = excluded.keywords, fetched_at = excluded.fetched_at",
        [id, JSON.stringify(keywords), Date.now()],
      );
      count(id, keywords);
    });
  }
  return found;
};

// For the tests: forget the counts (a fresh database).
export const resetKeywordStats = () => {
  stats = null;
};
