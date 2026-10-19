import { all, run } from "../db/index.js";
import { getXPCollections } from "./collections.js";
import { getMovieById } from "./movies.js";

// XP and level, worked out on the server from the watch history, so the
// numbers friends see can't be made up by a modified app. The rules are
// the app's own (src/utils/xp.js) and must stay identical to them — the app
// shows your level from the same formula without waiting for the server.
// The collections are lib/collections.js, which the app gets from here.
//
// XP is earned only from what you've watched:
//   100 per movie · 50 per genre · 50 per decade
//   75 per director you've seen 3+ films by
//   150 per saga rank reached (lib/collections.js — "Prefect", "Hogwarts
//       Graduate"…)
//   10 per rated movie
// Rewatches add nothing; nothing depends on order or dates.

export const WATCH_XP = 100;
export const NEW_GENRE_XP = 50;
export const NEW_DECADE_XP = 50;
export const DIRECTOR_DEPTH_XP = 75;
export const DIRECTOR_DEPTH_FILMS = 3;
export const RANK_XP = 150;
export const RATE_XP = 10;

export const decadeOf = (year) => `${Math.floor(year / 10) * 10}s`;

// A watched entry counts as rated with a tier — or an old star rating.
const isRated = (entry) => entry.tier != null || entry.rating != null;

// `watched`: [{ movieId, tier, rating }]. `catalog`: { lookup, xpCollections }:
// any movie the server has counts for movies, genres, decades and
// directors; `xpCollections` are the sagas, [{ movieIds, ranks: [count] }].
export const computeXP = (watched, catalog) => {
  const movies = watched
    .map((entry) => catalog.lookup(entry.movieId))
    .filter(Boolean);
  const genres = new Set(movies.flatMap((movie) => movie.genres));
  const decades = new Set(movies.map((movie) => decadeOf(movie.year)));
  const directorCounts = new Map();
  movies.forEach((movie) =>
    directorCounts.set(movie.director, (directorCounts.get(movie.director) ?? 0) + 1),
  );
  const deepDirectors = [...directorCounts.values()].filter(
    (count) => count >= DIRECTOR_DEPTH_FILMS,
  ).length;
  const watchedIds = new Set(watched.map((entry) => entry.movieId));
  const ranksReached = catalog.xpCollections.reduce((sum, saga) => {
    const count = saga.movieIds.filter((id) => watchedIds.has(id)).length;
    return sum + saga.ranks.filter((at) => count >= at).length;
  }, 0);

  return (
    movies.length * WATCH_XP +
    genres.size * NEW_GENRE_XP +
    decades.size * NEW_DECADE_XP +
    deepDirectors * DIRECTOR_DEPTH_XP +
    ranksReached * RANK_XP +
    watched.filter(isRated).length * RATE_XP
  );
};

// XP needed to clear a level grows steadily; the level is how many you've
// cleared, plus one.
const levelRequirement = (level) => 800 + (level - 1) * 90;

export const levelFor = (xp) => {
  let level = 1;
  let remaining = xp;
  while (remaining >= levelRequirement(level)) {
    remaining -= levelRequirement(level);
    level += 1;
  }
  return level;
};

// The pool never changes while the server runs, so its collections are
// worked out once.
let catalog = null;
// The pool or the sagas changed (the admin site): work it out again.
export const resetXPCatalog = () => {
  catalog = null;
};
const getCatalog = () => {
  catalog ??= { lookup: getMovieById, xpCollections: getXPCollections() };
  return catalog;
};

// Recomputes and stores a user's XP and level — call after anything that
// changes their watch history.
export const updateLevel = (userId) => {
  const watched = all("SELECT movie_id, tier, rating FROM watched WHERE user_id = ?", [
    userId,
  ]).map((row) => ({ movieId: row.movie_id, tier: row.tier, rating: row.rating }));
  const xp = computeXP(watched, getCatalog());
  run("UPDATE users SET xp = ?, level = ? WHERE id = ?", [xp, levelFor(xp), userId]);
};

// Recomputes everyone — on start-up, so values the app used to report (or a
// changed catalog) are corrected.
export const updateAllLevels = () => {
  const users = all("SELECT id FROM users");
  users.forEach((user) => updateLevel(user.id));
  return users.length;
};
