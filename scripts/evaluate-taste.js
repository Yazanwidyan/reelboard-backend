// How good is the taste engine's data, and does its "feels like your taste"
// signal earn its weight? Run: npm run evaluate-taste
//
// 1. The Taste DNA estimates. Only the hand-tagged films have real scores;
//    every other film's six scores are estimated (lib/tmdbMovies). Here the
//    estimator is tested on hand-tagged films it didn't learn from (10-fold
//    cross-validation): how far off it is per dimension, against simply
//    guessing the average — the current estimator, and one that also reads
//    TMDB's keywords (movie_keywords).
// 2. A backtest on real tiers: for each account with enough of them, some
//    of its S/A films are hidden and the rest stand for its taste; how high
//    do the hidden ones rank among every film it hasn't seen? Compared:
//    TMDB quality + genre (a baseline), closeness to the average of its
//    loved films (the engine's centroid), closeness to its single nearest
//    loved film, and each DNA signal added to the baseline.
//
// Reads the database only; changes nothing.

import { all, openDatabase } from "../src/db/index.js";
import { fitRidge, predictRidge, vibeFeatures } from "../src/lib/tmdbMovies.js";

const DIMENSIONS = ["dark", "fast", "mind-bending", "heavy", "epic", "fantastical"];
const FOLDS = 10;
const SPLITS = 20;
const HOLD_OUT = 0.3;
const MIN_TIERS = 20;
const MIN_LOVED = 8;
// The app's weights (utils/tasteEngine): S +3 … F −2.5; untiered as given.
const TIER_WEIGHT = { S: 3, A: 2, B: 1, C: 0.5, D: -1.5, F: -2.5 };

// A repeatable shuffle.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const toScore = (value) => Math.max(1, Math.min(5, Math.round(value)));
const fixed = (value, digits = 2) => value.toFixed(digits);

openDatabase();
const parse = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};
const movies = all("SELECT * FROM movies").map((row) => ({
  id: row.id,
  title: row.title,
  year: row.year,
  rating: row.rating,
  runtime: row.runtime,
  genres: parse(row.genres, []),
  details: parse(row.details, null),
  description: row.description,
  vibe: parse(row.vibe, null),
  hand: row.vibe_source === "hand",
  inPool: row.in_pool === 1,
}));
const byId = new Map(movies.map((movie) => [movie.id, movie]));
const keywordsOf = new Map(all("SELECT movie_id, keywords FROM movie_keywords").map((row) => [row.movie_id, parse(row.keywords, [])]));

// ---- 1. The estimates ---------------------------------------------------------

// Keyword features: the keywords at least MIN_SHARE of the training films
// carry (no more than MAX_KEYWORDS), one 0/1 column each.
const MIN_SHARE = 3;
const MAX_KEYWORDS = 150;
const keywordVocabulary = (train) => {
  const counts = new Map();
  train.forEach((movie) => (keywordsOf.get(movie.id) ?? []).forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1)));
  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_SHARE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS)
    .map(([word]) => word);
};
const withKeywords = (movie, vocabulary) => {
  const words = new Set(keywordsOf.get(movie.id) ?? []);
  return [...vibeFeatures(movie), ...vocabulary.map((word) => (words.has(word) ? 1 : 0))];
};

const hand = shuffle(movies.filter((movie) => movie.hand && movie.vibe?.dims?.length === 6));
const variants = {
  "guess the average": () => null,
  "current estimator": () => ({ features: (movie) => vibeFeatures(movie), lambda: 1 }),
  "+ TMDB keywords (λ 10)": (train) => {
    const vocabulary = keywordVocabulary(train);
    return { features: (movie) => withKeywords(movie, vocabulary), lambda: 10 };
  },
  "+ TMDB keywords (λ 30)": (train) => {
    const vocabulary = keywordVocabulary(train);
    return { features: (movie) => withKeywords(movie, vocabulary), lambda: 30 };
  },
};

console.log(`\n1. Taste DNA estimates — ${hand.length} hand-tagged films, ${FOLDS}-fold cross-validation`);
console.log("   Average error in points (1–5 scale), after rounding as the app does. Lower is better.\n");
const results = {};
for (const [name, build] of Object.entries(variants)) {
  const errors = DIMENSIONS.map(() => []);
  for (let fold = 0; fold < FOLDS; fold += 1) {
    const test = hand.filter((_, i) => i % FOLDS === fold);
    const train = hand.filter((_, i) => i % FOLDS !== fold);
    const setup = build(train);
    DIMENSIONS.forEach((_, d) => {
      const targets = train.map((movie) => movie.vibe.dims[d]);
      if (!setup) {
        const average = mean(targets);
        test.forEach((movie) => errors[d].push(Math.abs(toScore(average) - movie.vibe.dims[d])));
        return;
      }
      const weights = fitRidge(train.map(setup.features), targets, setup.lambda);
      test.forEach((movie) => errors[d].push(Math.abs(toScore(predictRidge(weights, setup.features(movie))) - movie.vibe.dims[d])));
    });
  }
  results[name] = errors.map(mean);
}
const pad = (text, width) => String(text).padEnd(width);
console.log(`   ${pad("", 26)}${DIMENSIONS.map((dim) => pad(dim, 14)).join("")}overall`);
for (const [name, errors] of Object.entries(results)) {
  console.log(`   ${pad(name, 26)}${errors.map((error) => pad(fixed(error), 14)).join("")}${fixed(mean(errors))}`);
}

// ---- 2. The backtest -----------------------------------------------------------

const dimsOf = (movie) => movie.vibe?.dims ?? [3, 3, 3, 3, 3, 3];
const MAX_DISTANCE = Math.sqrt(6 * 16);
const closeness = (a, b) => 1 - Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0)) / MAX_DISTANCE;
const votesOf = (movie) => movie.details?.votes ?? 0;
// TMDB quality, its rating pulled toward 6.5 when few voted.
const quality = (movie) => {
  const votes = votesOf(movie);
  return (votes / (votes + 1000)) * (movie.rating || 6.5) + (1000 / (votes + 1000)) * 6.5;
};
const zScores = (values) => {
  const average = mean(values);
  const spread = Math.sqrt(mean(values.map((value) => (value - average) ** 2))) || 1;
  return values.map((value) => (value - average) / spread);
};

const accounts = all(
  `SELECT user_id, COUNT(*) AS tiers, SUM(tier IN ('S','A')) AS loved FROM watched
   WHERE tier IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= ? AND SUM(tier IN ('S','A')) >= ?`,
  [MIN_TIERS, MIN_LOVED],
);
const pool = movies.filter((movie) => movie.inPool);
console.log(`\n2. Backtest — ${accounts.length} account(s) with ${MIN_TIERS}+ tiers and ${MIN_LOVED}+ S/A films, ${SPLITS} random splits each`);
console.log(`   ${Math.round(HOLD_OUT * 100)}% of each account's S/A films hidden; where do they rank among every pool film it hasn't seen?`);
console.log("   Rank percentile: 0% = top of the list, 50% = no better than chance. Top 100: share of hidden films in the first 100.\n");

const methods = [
  "quality + genre (baseline)",
  "DNA: average of loved",
  "DNA: nearest loved film",
  "baseline + DNA average",
  "baseline + DNA nearest",
  // The engine's own sums (utils/tasteEngine's weights and scales): today
  // (closeness to the average of loved films), and closeness to the 3
  // nearest loved films instead — at the same weight, and at half.
  "engine today (average)",
  "engine, 3 nearest (2.4)",
  "engine, 3 nearest (1.2)",
  "quality alone",
  "genre alone",
  "engine, 3 nearest (1.2), quality ×2.5",
];
const tally = Object.fromEntries(methods.map((method) => [method, { percentiles: [], top: [] }]));

for (const account of accounts) {
  const entries = all("SELECT movie_id, tier FROM watched WHERE user_id = ?", [account.user_id]).filter((entry) =>
    byId.has(entry.movie_id),
  );
  const seen = new Set(entries.map((entry) => entry.movie_id));
  const loved = entries.filter((entry) => entry.tier === "S" || entry.tier === "A");
  for (let split = 0; split < SPLITS; split += 1) {
    const hidden = new Set(shuffle(loved).slice(0, Math.max(1, Math.round(loved.length * HOLD_OUT))).map((entry) => entry.movie_id));
    const known = entries.filter((entry) => !hidden.has(entry.movie_id) && entry.tier);
    // The engine's two fingerprints, and the genres it leans to.
    const liked = [0, 0, 0, 0, 0, 0];
    const disliked = [0, 0, 0, 0, 0, 0];
    let likedWeight = 0;
    let dislikedWeight = 0;
    const genreWeight = new Map();
    known.forEach((entry) => {
      const movie = byId.get(entry.movie_id);
      const weight = TIER_WEIGHT[entry.tier] ?? 0;
      const dims = dimsOf(movie);
      if (weight > 0) {
        dims.forEach((value, i) => (liked[i] += weight * value));
        likedWeight += weight;
      } else if (weight < 0) {
        dims.forEach((value, i) => (disliked[i] += -weight * value));
        dislikedWeight += -weight;
      }
      movie.genres.forEach((genre) => genreWeight.set(genre, (genreWeight.get(genre) ?? 0) + weight));
    });
    const likedCentroid = liked.map((value) => value / (likedWeight || 1));
    const dislikedCentroid = dislikedWeight ? disliked.map((value) => value / dislikedWeight) : null;
    const lovedDims = known.filter((entry) => entry.tier === "S" || entry.tier === "A").map((entry) => dimsOf(byId.get(entry.movie_id)));

    const candidates = pool.filter((movie) => !seen.has(movie.id) || hidden.has(movie.id));
    const genreFit = candidates.map((movie) => mean(movie.genres.map((genre) => genreWeight.get(genre) ?? 0)));
    const genreZ = zScores(genreFit);
    const base = zScores(candidates.map(quality)).map((value, i) => value + genreZ[i]);
    const average = zScores(
      candidates.map(
        (movie) =>
          2.4 * closeness(dimsOf(movie), likedCentroid) - (dislikedCentroid ? 1.6 * closeness(dimsOf(movie), dislikedCentroid) : 0),
      ),
    );
    const nearest = zScores(candidates.map((movie) => Math.max(...lovedDims.map((dims) => closeness(dimsOf(movie), dims)))));
    const nearestThree = (movie) =>
      mean(
        lovedDims
          .map((dims) => closeness(dimsOf(movie), dims))
          .sort((a, b) => b - a)
          .slice(0, 3),
      );
    const disliking = (movie) => {
      if (!dislikedCentroid) return 0;
      const fit = closeness(dislikedCentroid, dimsOf(movie));
      return fit > 0.75 ? -1.6 * (fit - 0.75) * 8 : 0;
    };
    const rest = (movie, i, qualityWeight = 0.8) => qualityWeight * (quality(movie) - 7.5) + 0.35 * genreFit[i] + disliking(movie);
    const engine = (fitOf, weight, qualityWeight) =>
      candidates.map((movie, i) => weight * (fitOf(movie) - 0.65) * 5 + rest(movie, i, qualityWeight));
    const scores = {
      [methods[0]]: base,
      [methods[1]]: average,
      [methods[2]]: nearest,
      [methods[3]]: base.map((value, i) => value + average[i]),
      [methods[4]]: base.map((value, i) => value + nearest[i]),
      [methods[5]]: engine((movie) => closeness(dimsOf(movie), likedCentroid), 2.4),
      [methods[6]]: engine(nearestThree, 2.4),
      [methods[7]]: engine(nearestThree, 1.2),
      [methods[8]]: candidates.map(quality),
      [methods[9]]: genreFit,
      [methods[10]]: engine(nearestThree, 1.2, 2),
    };
    for (const method of methods) {
      const order = candidates.map((movie, i) => ({ id: movie.id, score: scores[method][i] })).sort((a, b) => b.score - a.score);
      const position = new Map(order.map((item, i) => [item.id, i]));
      hidden.forEach((id) => {
        if (!position.has(id)) return;
        tally[method].percentiles.push(position.get(id) / order.length);
        tally[method].top.push(position.get(id) < 100 ? 1 : 0);
      });
    }
  }
}
if (accounts.length === 0) {
  console.log("   No account has enough tiers yet.");
} else {
  console.log(`   ${pad("", 30)}${pad("rank percentile", 18)}top 100`);
  for (const method of methods) {
    const { percentiles, top } = tally[method];
    console.log(`   ${pad(method, 30)}${pad(`${fixed(mean(percentiles) * 100, 1)}%`, 18)}${fixed(mean(top) * 100, 0)}%`);
  }
}
console.log("");
