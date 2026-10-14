import { all, fromJSON } from "../db/index.js";
import { badRequest } from "./errors.js";

// The catalog is small (250 movies) and read-only at runtime, so it's held
// in memory once loaded and filtered in JS with the same rules the app uses
// (src/utils/movieFilters.js) — results match what the app shows offline.

let cache = null;

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
});

export const getAllMovies = () => {
  if (!cache) {
    const movies = all("SELECT * FROM movies ORDER BY rank").map(rowToMovie);
    cache = { list: movies, byId: new Map(movies.map((movie) => [movie.id, movie])) };
  }
  return cache.list;
};

export const getMovieById = (id) => {
  getAllMovies();
  return cache.byId.get(id) ?? null;
};

export const assertMovie = (movieId) => {
  const movie = getMovieById(movieId);
  if (!movie) throw badRequest(`Unknown movie id "${movieId}"`);
  return movie;
};

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

export const matchesSearch = (movie, term) => {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return (
    movie.title.toLowerCase().includes(needle) ||
    movie.director?.toLowerCase().includes(needle) ||
    movie.cast.some((name) => name.toLowerCase().includes(needle)) ||
    String(movie.year) === needle
  );
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
