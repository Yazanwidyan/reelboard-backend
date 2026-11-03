import { all, catalogMeta, fromJSON, get, upsertMovie } from "../db/index.js";
import { HttpError, notFound } from "./errors.js";
import { tmdbGet } from "./tmdb.js";
import { MOVIE_PARAMS, toMovie, trainVibes } from "./tmdbMovies.js";

// Movies, by TMDB id. Two kinds:
//   the pool   TMDB's well-known movies (500+ votes, about 8,000), with
//              hand-tuned or estimated vibes — in the movies table
//              (in_pool = 1), written by `npm run build-pool`. Read-only
//              while the server runs, so it's held in memory and filtered in
//              JS with the app's own rules (src/utils/movieFilters.js).
//              Candidates (lib/candidates.js) and collections
//              (lib/collections.js) come from these. The app never downloads
//              the pool.
//   the rest   any other TMDB movie, fetched the first time someone opens or
//              saves it (ensureMovie) and kept in the movies table, refreshed
//              when it's older than a week.

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MOVIE_ID = /^\d{1,10}$/;

let pool = null; // { list, byId }
const others = new Map(); // non-pool movies read from the table, by id

const rowToMovie = (row) => ({
  id: row.id,
  rank: row.rank,
  title: row.title,
  year: row.year,
  rating: row.rating,
  runtime: row.runtime,
  genres: fromJSON(row.genres, []),
  director: row.director,
  cast: fromJSON(row.cast, []),
  details: fromJSON(row.details),
  description: row.description,
  franchise: row.franchise,
  poster: row.poster,
  backdrop: row.backdrop,
  vibe: fromJSON(row.vibe),
  vibeSource: row.vibe_source,
  inPool: row.in_pool === 1,
  fetchedAt: row.fetched_at,
});

// Forget what's been read (the admin site changed the pool or a movie).
export const resetMovieCache = () => {
  pool = null;
  others.clear();
};

// The pool, in rank order.
export const getAllMovies = () => {
  if (!pool) {
    const movies = all("SELECT * FROM movies WHERE in_pool = 1 ORDER BY rank").map(rowToMovie);
    pool = { list: movies, byId: new Map(movies.map((movie) => [movie.id, movie])) };
    // New movies' vibes are estimated from the pool's hand-tagged ones.
    trainVibes(
      movies.filter((movie) => movie.vibeSource === "hand"),
      catalogMeta.themes,
    );
  }
  return pool.list;
};

export const isPoolMovie = (id) => {
  getAllMovies();
  return pool.byId.has(id);
};

// Any movie the server already has (pool or not), or null. Never asks TMDB.
export const getMovieById = (id) => {
  getAllMovies();
  const inPool = pool.byId.get(id);
  if (inPool) return inPool;
  if (others.has(id)) return others.get(id);
  const row = get("SELECT * FROM movies WHERE id = ?", [id]);
  const movie = row ? rowToMovie(row) : null;
  if (movie) others.set(id, movie);
  return movie;
};

// The movie, from TMDB if the server doesn't have it yet (or has an old
// copy). Throws 404 for an id TMDB doesn't know; if TMDB can't be reached,
// a copy the server already has will do.
const fetching = new Map();
export const ensureMovie = async (id) => {
  if (!MOVIE_ID.test(String(id))) throw notFound(`No movie with id "${id}"`);
  const known = getMovieById(id);
  if (known && (known.inPool || Date.now() - known.fetchedAt < REFRESH_AFTER_MS)) return known;
  if (fetching.has(id)) return fetching.get(id);
  const task = (async () => {
    try {
      const record = await tmdbGet(`/movie/${id}`, MOVIE_PARAMS);
      if (!record || record.adult) {
        if (known) return known;
        throw notFound(`No movie with id "${id}"`);
      }
      upsertMovie(toMovie(record));
      others.delete(id);
      return getMovieById(id);
    } catch (error) {
      if (known && error instanceof HttpError && error.status >= 500) return known;
      throw error;
    } finally {
      fetching.delete(id);
    }
  })();
  fetching.set(id, task);
  return task;
};

// Several at once (a few at a time), in the order given. Unknown ids are
// left out unless `strict`, which throws for the first one instead.
export const ensureMovies = async (ids, { strict = false } = {}) => {
  const unique = [...new Set(ids)];
  const found = new Map();
  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map((id) => ensureMovie(id)));
    results.forEach((result, j) => {
      if (result.status === "fulfilled") found.set(batch[j], result.value);
      else if (strict || !(result.reason instanceof HttpError && result.reason.status === 404)) {
        throw result.reason;
      }
    });
  }
  return ids.map((id) => found.get(id)).filter(Boolean);
};

// A movie as lists and the catalog carry it: everything but the movie
// page's extras (cast photos, crew), which GET /api/movies/:id sends.
const PAGE_ONLY = ["castDetails", "directors", "writers", "budget", "revenue"];
export const toLean = ({ inPool, fetchedAt, vibeSource, ...movie }) => ({
  ...movie,
  details: movie.details
    ? Object.fromEntries(Object.entries(movie.details).filter(([key]) => !PAGE_ONLY.includes(key)))
    : null,
});

// The movies behind a list of ids — what a response sends alongside ids.
// The app doesn't download the pool, so it only knows the movies responses
// bring it (services/api.js remembers every response's `movies`). Only
// movies the server has; never asks TMDB.
export const moviesFor = (ids) =>
  [...new Set(ids)]
    .filter(Boolean)
    .map(getMovieById)
    .filter(Boolean)
    .map(toLean);

export const getGenres = () =>
  [...new Set(getAllMovies().flatMap((movie) => movie.genres))].sort();

// ---- Filters (mirrors the app's utils/movieFilters.js) --------------------

export const DECADE_RANGES = {
  Any: null,
  "2020s": [2020, 2029],
  "2010s": [2010, 2019],
  "2000s": [2000, 2009],
  "1990s": [1990, 1999],
  "1980s": [1980, 1989],
  "1970s": [1970, 1979],
  Older: [0, 1969],
};

export const RUNTIME_RANGES = {
  Any: null,
  "Under 2 hours": [0, 119],
  "2–3 hours": [120, 180],
  "3+ hours": [181, 9999],
};

const inRange = (value, range) => !range || (value >= range[0] && value <= range[1]);

export const applyPreferenceFilters = (movies, preferences = {}) =>
  movies.filter(
    (movie) =>
      (!preferences.genres?.length ||
        movie.genres.some((genre) => preferences.genres.includes(genre))) &&
      (!preferences.minRating || movie.rating >= preferences.minRating) &&
      inRange(movie.year, DECADE_RANGES[preferences.decade]) &&
      inRange(movie.runtime, RUNTIME_RANGES[preferences.runtime]),
  );

// ---- Search (the app's utils/movieSearch, in short) -----------------------
//
// Forgiving the way people type: case, accents, punctuation and spaces
// don't matter ("spiderman" finds "Spider-Man", "amelie" "Amélie"), Arabic
// without its vowel marks; any script's letters count.
const normalizeSearch = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, "")
    .toLowerCase()
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064a")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const squash = (text) => text.replace(/ /g, "");
// Shorter than this, only the start of a word matches, spaces and all ("it"
// isn't "I, Tonya").
const MIN_ANYWHERE = 3;

// 4 the whole text, 3 its start, 2 a word's start, 1 anywhere, 0 none.
const strength = (query, text) => {
  if (!text) return 0;
  const q = squash(query);
  const t = squash(text);
  if (text === query || t === q) return 4;
  if (text.startsWith(query)) return 3;
  if (q.length >= MIN_ANYWHERE && t.startsWith(q)) return 3;
  if (` ${text}`.includes(` ${query}`)) return 2;
  if (q.length < MIN_ANYWHERE) return 0;
  return text.includes(query) || t.includes(q) ? 1 : 0;
};

// How well a movie matches a search, 0 (not at all) up: its title first
// ("the" dropped too), then its director, its cast, its year.
export const searchScore = (movie, term) => {
  const query = normalizeSearch(term);
  if (!query) return 1;
  const title = normalizeSearch(movie.title);
  const byTitle = Math.max(strength(query, title), strength(query, title.replace(/^(the|a|an) /, "")));
  if (byTitle) return 100 + byTitle * 10;
  const byDirector = strength(query, normalizeSearch(movie.director));
  if (byDirector > 1) return 60 + byDirector * 5;
  const byCast = Math.max(0, ...(movie.cast ?? []).map((name) => strength(query, normalizeSearch(name))));
  if (byCast > 1) return 40 + byCast * 5;
  if (query === String(movie.year)) return 30;
  return byDirector || byCast ? 10 : 0;
};


// ---- Recommendations (mirrors the app's services/recommendations.js) ------

export const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// Relax filters step by step so a full pick is (almost) always possible
// while still favoring the user's preferences when there's enough supply.
const RELAXATION_STEPS = [
  (prefs) => prefs,
  (prefs) => ({ ...prefs, runtime: "Any" }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any" }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any", minRating: null }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any", minRating: null, genres: [] }),
];

// `priorityIds` (the watchlist) get guaranteed slots and skip the filters;
// `skipIds` (already watched) are left out of the filtered picks.
export const generateRecommendations = ({
  preferences = {},
  count = 10,
  priorityIds = [],
  skipIds = [],
}) => {
  const movies = getAllMovies();
  const prioritySet = new Set(priorityIds);
  const priorityPicks = shuffle(movies.filter((movie) => prioritySet.has(movie.id))).slice(
    0,
    count,
  );
  const remaining = count - priorityPicks.length;
  if (remaining <= 0) return priorityPicks;

  const excluded = new Set([...priorityPicks.map((movie) => movie.id), ...skipIds]);
  const pool = movies.filter((movie) => !excluded.has(movie.id));
  let rest = null;
  for (const relax of RELAXATION_STEPS) {
    const filtered = applyPreferenceFilters(pool, relax(preferences));
    if (filtered.length >= remaining) {
      rest = shuffle(filtered).slice(0, remaining);
      break;
    }
  }
  rest ??= shuffle(pool).slice(0, remaining);
  return shuffle([...priorityPicks, ...rest]);
};
