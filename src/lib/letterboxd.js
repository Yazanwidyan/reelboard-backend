import { get } from "../db/index.js";
import { HttpError } from "./errors.js";
import { ensureMovie } from "./movies.js";
import { tmdbGet } from "./tmdb.js";

// A Letterboxd export (watched.csv, ratings.csv, diary.csv, watchlist.csv)
// names films by title and year, not by id. The app reads the CSVs and
// sends the rows; each is matched here — to a movie already in the table,
// else through TMDB's search — and stored by its TMDB id.

// Letterboxd's 0.5–5 stars as a tier, the way the app reads old ratings:
// 5★ → S, 4–4.5★ → A, 3–3.5★ → B, 2–2.5★ → C, 1–1.5★ → D, 0.5★ → F.
export const starsToTier = (stars) => {
  if (stars == null) return null;
  if (stars >= 5) return "S";
  if (stars >= 4) return "A";
  if (stars >= 3) return "B";
  if (stars >= 2) return "C";
  if (stars >= 1) return "D";
  return "F";
};

// A movie already in the table with this title, from (about) that year.
const known = (title, year) => {
  const row = get(
    `SELECT id, year FROM movies WHERE title = ? COLLATE NOCASE
     ORDER BY abs(coalesce(year, 0) - ?) LIMIT 1`,
    [title, year ?? 0],
  );
  if (!row || (year && Math.abs((row.year ?? 0) - year) > 1)) return null;
  return row.id;
};

const searchTmdb = async (title, year) => {
  const search = (params) =>
    tmdbGet("/search/movie", { query: title, include_adult: "false", ...params }, { ttl: 60 * 60 * 1000 });
  // Letterboxd's year is the first release; TMDB's primary one can be a
  // year later, so the search widens before giving up.
  let results = year ? (await search({ primary_release_year: year })).results : [];
  if (!results?.length && year) results = (await search({ year })).results;
  if (!results?.length) results = (await search({})).results;
  return results?.find((result) => !result.adult)?.id ?? null;
};

// One row → a TMDB id (string), or null when nothing fits.
export const matchFilm = async ({ title, year }) => {
  const local = known(title, year);
  if (local) return local;
  try {
    const id = await searchTmdb(title, year);
    if (!id) return null;
    return (await ensureMovie(String(id))).id;
  } catch (error) {
    // A film TMDB doesn't have (or won't serve) is skipped; TMDB being down
    // fails the import so it can be tried again.
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
};

// Matches rows a few at a time — TMDB doesn't like a thousand at once.
export const matchFilms = async (rows) => {
  const ids = [];
  for (let i = 0; i < rows.length; i += 6) {
    ids.push(...(await Promise.all(rows.slice(i, i + 6).map(matchFilm))));
  }
  return ids;
};
