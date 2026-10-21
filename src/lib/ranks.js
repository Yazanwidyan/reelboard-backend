import { all, fromJSON, get, run, toJSON } from "../db/index.js";
import { getMovieById } from "./movies.js";
import { titleStepFor } from "./titles.js";

// Ranks — the one progress system. Everything you can achieve is a rank on
// a track, and how many ranks you have is your score; your title comes from
// that. Worked out here from the watch history (so what friends see can't
// be made up by a modified app), with the app's own rules
// (src/utils/ranks.js), which must stay identical: the app shows yours
// without waiting for the server.
//
// Two kinds of track:
//   craft       how you watch: decades, genres, directors, old films, harsh
//               tiers, long films, marathon days, rewatches, dares
//   milestones  how much: films watched, films tiered
// Sagas aren't ranks: each has its own ladder ("First Year → Prefect →
// Hogwarts Graduate", lib/collections.js), climbed on its own.
// A rank's id is its track's and its step's: "time-traveler:1". Nothing
// depends on order; rewatches count only for Comfort Watcher (and the day
// they were watched).

// Your title comes from how many ranks you have: lib/titles.js.

export const OLD_FILM_BEFORE = 1970;
export const LONG_FILM_MINUTES = 165;
export const MARATHON_FILMS = 3;
export const DEEP_DIRECTOR_FILMS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Craft and milestone tracks: the stat each counts, and its ladder
// ([films / genres / … needed, the rank's name]).
export const TRACKS = [
  {
    id: "films",
    stat: "watched",
    steps: [
      [1, "First Watch"],
      [10, "Ticket Stub"],
      [50, "Season Pass"],
      [100, "Centurion"],
      [250, "Reel Collector"],
      [500, "Film Buff"],
      [1000, "Hall of Fame"],
    ],
  },
  {
    id: "tiered",
    stat: "tiered",
    steps: [
      [10, "Opinionated"],
      [50, "Reviewer"],
      [100, "Trusted Voice"],
      [250, "Seasoned Reviewer"],
      [500, "Master Reviewer"],
    ],
  },
  { id: "time-traveler", stat: "decades", steps: [[4, "Tourist"], [7, "Explorer"], [10, "Time Lord"]] },
  { id: "genre-hopper", stat: "genres", steps: [[6, "Sampler"], [10, "Hopper"], [15, "Omnivore"]] },
  { id: "auteur-hunter", stat: "directors", steps: [[2, "Fan"], [6, "Devotee"], [15, "Auteur Hunter"]] },
  { id: "old-soul", stat: "oldFilms", steps: [[3, "Matinee"], [12, "Golden Age"], [30, "Old Soul"]] },
  { id: "tough-critic", stat: "harsh", steps: [[3, "Honest"], [10, "Harsh"], [25, "Ruthless"]] },
  { id: "long-haul", stat: "longFilms", steps: [[3, "Patient"], [10, "Committed"], [25, "Epic Soul"]] },
  { id: "marathoner", stat: "marathons", steps: [[1, "Binger"], [5, "Marathoner"], [15, "Iron Eyes"]] },
  { id: "comfort-watcher", stat: "rewatched", steps: [[3, "Comfort"], [10, "Returner"], [25, "Old Friend"]] },
  { id: "dare-devil", stat: "dares", steps: [[1, "Daredevil"], [10, "Thrill Seeker"], [50, "Fearless"]] },
];

const decadeOf = (year) => Math.floor(year / 10) * 10;
const isTiered = (entry) => entry.tier != null || entry.rating != null;
// A legacy star rating of under 2 stars is a D or an F.
const isHarsh = (entry) =>
  entry.tier === "D" || entry.tier === "F" || (entry.tier == null && entry.rating != null && entry.rating < 2);

// What the craft and milestone tracks count. `watched`: [{ movieId, tier,
// rating, watchCount, watchedAt }]; `lookup`: a movie by id (any the server
// has); `dares`: how many dares were finished.
export const watchStats = (watched, lookup, dares = 0) => {
  const movies = watched.map((entry) => lookup(entry.movieId)).filter(Boolean);
  const directorCounts = new Map();
  movies.forEach((movie) => {
    if (movie.director) directorCounts.set(movie.director, (directorCounts.get(movie.director) ?? 0) + 1);
  });
  const perDay = new Map();
  watched.forEach((entry) => {
    if (!entry.watchedAt) return;
    const day = Math.floor(entry.watchedAt / DAY_MS);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  });
  return {
    watched: watched.length,
    tiered: watched.filter(isTiered).length,
    decades: new Set(movies.filter((movie) => movie.year).map((movie) => decadeOf(movie.year))).size,
    genres: new Set(movies.flatMap((movie) => movie.genres ?? [])).size,
    directors: [...directorCounts.values()].filter((count) => count >= DEEP_DIRECTOR_FILMS).length,
    oldFilms: movies.filter((movie) => movie.year && movie.year < OLD_FILM_BEFORE).length,
    harsh: watched.filter(isHarsh).length,
    longFilms: movies.filter((movie) => (movie.runtime ?? 0) >= LONG_FILM_MINUTES).length,
    marathons: [...perDay.values()].filter((count) => count >= MARATHON_FILMS).length,
    rewatched: watched.filter((entry) => (entry.watchCount ?? 1) > 1).length,
    dares,
  };
};

// Every rank these reach: [rank id]. `lookup`: a movie by id.
export const computeRanks = (watched, lookup, dares = 0) => {
  const stats = watchStats(watched, lookup, dares);
  const ids = [];
  TRACKS.forEach((track) =>
    track.steps.forEach(([at], index) => {
      if (stats[track.stat] >= at) ids.push(`${track.id}:${index + 1}`);
    }),
  );
  return ids;
};

// Recomputes and stores a user's ranks and title — call after anything
// that changes their watch history or finishes a dare.
export const updateRanks = (userId) => {
  const watched = all(
    "SELECT movie_id, tier, rating, watch_count, watched_at FROM watched WHERE user_id = ?",
    [userId],
  ).map((row) => ({
    movieId: row.movie_id,
    tier: row.tier,
    rating: row.rating,
    watchCount: row.watch_count,
    watchedAt: row.watched_at,
  }));
  const dares = get("SELECT COUNT(*) AS count FROM challenges WHERE user_id = ? AND status = 'completed'", [
    userId,
  ]).count;
  const ids = computeRanks(watched, getMovieById, dares);
  run("UPDATE users SET ranks = ?, rank_ids = ?, level = ? WHERE id = ?", [
    ids.length,
    toJSON(ids),
    titleStepFor(ids.length),
    userId,
  ]);
  rarity = null;
};

// Everyone — on start-up, so changed rules reach every account.
export const updateAllRanks = () => {
  const users = all("SELECT id FROM users");
  users.forEach((user) => updateRanks(user.id));
  return users.length;
};

// How rare each rank is: the share of watchers (anyone with a rank) who
// have it, in whole percent (at least 1 when anyone does). Worked out when
// asked and kept until someone's ranks change.
let rarity = null;
export const getRankRarity = () => {
  if (rarity) return rarity;
  const rows = all("SELECT rank_ids FROM users WHERE ranks > 0");
  const counts = new Map();
  rows.forEach((row) =>
    fromJSON(row.rank_ids, []).forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1)),
  );
  rarity = {
    watchers: rows.length,
    rarity: Object.fromEntries(
      [...counts.entries()].map(([id, count]) => [id, Math.max(1, Math.round((count / rows.length) * 100))]),
    ),
  };
  return rarity;
};
