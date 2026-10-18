import { applyPreferenceFilters, getAllMovies, getMovieById, shuffle } from "./movies.js";

// Candidates: the movies the app chooses from — Swipe, Spin, Taste pick,
// dares, the Decide and Home rails. The app doesn't download the pool
// (8,000 movies); it asks for a few hundred of them, picked for you:
//
//   1. the pool, minus what you've watched and recently passed on
//   2. your filters (genres, decade, runtime, rating) — if too few movies
//      match them, all that do, then the closest ones as the filters are
//      relaxed step by step
//   3. ranked by your taste — the app's own taste engine
//      (src/utils/tasteEngine.js), with its weights: how close a movie
//      feels to what you tier well, your genres, directors, actors, eras
//      and themes, and its rating. The app ranks them again, with the
//      reasons it shows, so this only has to get the right few hundred.
//   4. three quarters the best-ranked, a quarter picked at random from the
//      rest, so there's always something you wouldn't have guessed.
//
// The app saves the latest set, so it still has something to choose from
// offline.

export const DEFAULT_COUNT = 300;
const EXPLORE_SHARE = 0.25;
const PASS_HALF_LIFE_DAYS = 21;
// Passed on in the last week: left out altogether.
const RECENT_PASS_MS = 7 * 24 * 60 * 60 * 1000;

const TIER_WEIGHT = { S: 3, A: 2, B: 1, C: 0, D: -1.5, F: -2.5 };
const UNTIERED_WEIGHT = 0.5;
const PASS_WEIGHT = -0.6;
const LEANING_ALONE = 1.3;
const LEANING_NUDGE = 0.7;
const OPEN_DIMENSION_WEIGHT = 0.25;
const WEIGHTS = {
  vibe: 2.4,
  dislikedVibe: 1.6,
  theme: 0.6,
  genre: 0.35,
  director: 0.9,
  cast: 0.5,
  decade: 0.3,
  quality: 0.8,
  jitter: 0.7,
};
const DIMENSIONS = 6;
const NEUTRAL = { dims: [3, 3, 3, 3, 3, 3], themes: [] };
const MAX_DISTANCE = Math.sqrt(DIMENSIONS * 16);

const decadeOf = (year) => `${Math.floor(year / 10) * 10}s`;
const vibeOf = (movie) => movie.vibe ?? NEUTRAL;
const clampDim = (value) => Math.min(5, Math.max(1, value));

const weightedCloseness = (a, b, weights) => {
  const w = weights ?? a.map(() => 1);
  const total = w.reduce((sum, weight) => sum + weight, 0);
  const squared = a.reduce((sum, value, index) => sum + w[index] * (value - b[index]) ** 2, 0);
  return 1 - Math.sqrt((squared / total) * a.length) / MAX_DISTANCE;
};

// Your taste, from your tiers, passes and onboarding leanings — the app's
// buildTasteModel, less the aspect taps.
export const buildTasteModel = ({ watched = [], passes = [], leanings = null, now = Date.now() }) => {
  const maps = { genres: new Map(), directors: new Map(), cast: new Map(), decades: new Map(), themes: new Map() };
  const liked = { sum: Array(DIMENSIONS).fill(0), weight: 0 };
  const disliked = { sum: Array(DIMENSIONS).fill(0), weight: 0 };
  const add = (map, key, value) => {
    if (key == null) return;
    const current = map.get(key) ?? { sum: 0, count: 0 };
    current.sum += value;
    current.count += 1;
    map.set(key, current);
  };
  const learn = (movie, weight) => {
    movie.genres.forEach((genre) => add(maps.genres, genre, weight));
    add(maps.directors, movie.director, weight);
    (movie.cast ?? []).forEach((actor) => add(maps.cast, actor, weight));
    add(maps.decades, decadeOf(movie.year), weight);
    const vibe = vibeOf(movie);
    vibe.themes.forEach((theme) => add(maps.themes, theme, weight));
    const side = weight > 0 ? liked : weight < 0 ? disliked : null;
    if (side) {
      vibe.dims.forEach((value, index) => {
        side.sum[index] += Math.abs(weight) * value;
      });
      side.weight += Math.abs(weight);
    }
  };

  const watchedIds = new Set();
  watched.forEach((entry) => {
    const movie = getMovieById(entry.movieId);
    if (!movie) return;
    watchedIds.add(movie.id);
    const tier = entry.tier ?? null;
    learn(movie, tier ? TIER_WEIGHT[tier] ?? UNTIERED_WEIGHT : UNTIERED_WEIGHT);
  });
  passes.forEach((pass) => {
    if (watchedIds.has(pass.movieId)) return;
    const movie = getMovieById(pass.movieId);
    if (movie) learn(movie, PASS_WEIGHT * 0.5 ** ((now - pass.at) / (PASS_HALF_LIFE_DAYS * 86400000)));
  });

  const centroid = (side) => (side.weight > 0 ? side.sum.map((value) => value / side.weight) : null);
  let fingerprint = centroid(liked);
  let fingerprintWeights = null;
  if (leanings) {
    if (fingerprint) {
      fingerprint = fingerprint.map((value, index) => clampDim(value + (leanings[index] ?? 0) * LEANING_NUDGE));
    } else {
      fingerprint = leanings.map((lean) => clampDim(3 + (lean ?? 0) * LEANING_ALONE));
      fingerprintWeights = leanings.map((lean) => (lean ? 1 : OPEN_DIMENSION_WEIGHT));
    }
  }
  const affinity = (map, key) => {
    const value = map.get(key);
    return value ? value.sum / Math.sqrt(value.count) : 0;
  };
  return { ...maps, affinity, fingerprint, fingerprintWeights, dislikedCentroid: centroid(disliked) };
};

const bestPlusRest = (scores) => {
  const sorted = [...scores].sort((a, b) => b - a);
  if (!sorted.length || !sorted[0]) return 0;
  return sorted[0] + sorted.slice(1).reduce((sum, score) => sum + score, 0) * 0.3;
};

export const scoreMovie = (movie, model, random = Math.random) => {
  const { affinity } = model;
  const vibe = vibeOf(movie);
  let score = 0;
  if (model.fingerprint) {
    score += WEIGHTS.vibe * (weightedCloseness(model.fingerprint, vibe.dims, model.fingerprintWeights) - 0.65) * 5;
  }
  if (model.dislikedCentroid) {
    const fit = weightedCloseness(model.dislikedCentroid, vibe.dims);
    if (fit > 0.75) score -= WEIGHTS.dislikedVibe * (fit - 0.75) * 8;
  }
  score += WEIGHTS.theme * bestPlusRest(vibe.themes.map((theme) => affinity(model.themes, theme)));
  score += WEIGHTS.genre * bestPlusRest(movie.genres.map((genre) => affinity(model.genres, genre)));
  score += WEIGHTS.director * affinity(model.directors, movie.director);
  const actors = (movie.cast ?? []).map((actor) => affinity(model.cast, actor));
  if (actors.length) score += WEIGHTS.cast * Math.max(...actors);
  score += WEIGHTS.decade * affinity(model.decades, decadeOf(movie.year));
  score += WEIGHTS.quality * (movie.rating - 7.5);
  score += WEIGHTS.jitter * random();
  return score;
};

// Relax the filters step by step until enough movies match — the app's
// own order (services/recommendations.js).
const RELAXATION_STEPS = [
  (prefs) => prefs,
  (prefs) => ({ ...prefs, runtime: "Any" }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any" }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any", minRating: null }),
  (prefs) => ({ ...prefs, runtime: "Any", decade: "Any", minRating: null, genres: [] }),
];

// `watched`: [{ movieId, tier }]. `passes`: [{ movieId, at }]. `filters`:
// { genres, decade, runtime, minRating }. Returns pool movies, best first;
// `matching`: how many unwatched pool movies match the filters exactly.
export const pickCandidates = ({
  watched = [],
  passes = [],
  leanings = null,
  filters = {},
  count = DEFAULT_COUNT,
  now = Date.now(),
  random = Math.random,
}) => {
  const skip = new Set([
    ...watched.map((entry) => entry.movieId),
    ...passes.filter((pass) => now - pass.at < RECENT_PASS_MS).map((pass) => pass.movieId),
  ]);
  const pool = getAllMovies().filter((movie) => !skip.has(movie.id));
  const model = buildTasteModel({ watched, passes, leanings, now });
  const rank = (movies) =>
    movies
      .map((movie) => ({ movie, score: scoreMovie(movie, model, random) }))
      .sort((a, b) => b.score - a.score)
      .map(({ movie }) => movie);
  // The best-ranked share, and a random pick of the rest.
  const choose = (ranked, n) => {
    const best = Math.round(n * (1 - EXPLORE_SHARE));
    return [...ranked.slice(0, best), ...shuffle(ranked.slice(best)).slice(0, n - best)];
  };

  const exact = applyPreferenceFilters(pool, filters);
  if (exact.length >= count) {
    return { movies: choose(rank(exact), count), relaxed: 0, matching: exact.length };
  }
  // Too few match: every one that does, then the closest the loosened
  // filters find.
  let relaxed = 1;
  let wider = pool;
  for (; relaxed < RELAXATION_STEPS.length; relaxed += 1) {
    wider = applyPreferenceFilters(pool, RELAXATION_STEPS[relaxed](filters));
    if (wider.length >= count) break;
  }
  if (relaxed === RELAXATION_STEPS.length) {
    relaxed -= 1;
    wider = pool;
  }
  const exactIds = new Set(exact.map((movie) => movie.id));
  const extra = choose(
    rank(wider.filter((movie) => !exactIds.has(movie.id))),
    count - exact.length,
  );
  return { movies: [...rank(exact), ...extra], relaxed, matching: exact.length };
};
