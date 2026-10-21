import { getAllMovies } from "./movies.js";

// "More like this" for a movie page: every pool movie scored against it on
// what the two films share, best first, each with why.
//
//   feel     Taste DNA closeness — how alike they feel (the biggest part)
//   story    their descriptions: the rarer words both use count most
//   themes   themes they share (heists, revenge, space…)
//   genres   how many genres they share, not just the first
//   tmdb     TMDB recommends it for this movie
//   cast     an actor in both
//   era      made around the same time
//   rating   how good it is (counted by votes), so weak films don't slip in
//
// Films by the same director are left out — the movie page has its own
// "Also by" row for those.

const WEIGHTS = { feel: 3, story: 2.5, themes: 1.5, genres: 2, tmdb: 2, cast: 0.8, era: 0.5, rating: 2 };
// A signal this strong makes it one of the card's reasons.
const REASON_AT = { feel: 0.82, story: 0.12, themes: 0.5, genres: 0.66, tmdb: 1, cast: 1, era: 0.8 };
const MAX_DISTANCE = Math.sqrt(6 * 4 * 4); // six 1–5 dims
const ERA_SPAN = 25;
const NEUTRAL_DIMS = [3, 3, 3, 3, 3, 3];
// A rating counted by how many people gave it (IMDb's Top 250 formula, as
// in the app's utils/movieFilters), so a 9 from a few fans isn't "better".
const RATING_VOTES = 3000;
const AVERAGE_RATING = 6.7;
const weightedRating = (movie) => {
  const votes = movie.details?.votes ?? movie.votes ?? 0;
  return (votes / (votes + RATING_VOTES)) * (movie.rating ?? 0) + (RATING_VOTES / (votes + RATING_VOTES)) * AVERAGE_RATING;
};

// Words too common to tell two stories apart.
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have having he
  her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor
  not now of off on once only or other our ours out over own same she should so some such than that the their
  theirs them themselves then there these they this those through to too under until up very was we were what
  when where which while who whom why will with would you your yours yourself yourselves one two three new
  film movie story life world man woman men women young old year years day days time must find finds get gets
  becomes become takes take make makes way back when while along soon after first last own around ever every
  his her their himself herself who whose upon into onto against within without yet still even`.split(/\s+/),
);

const words = (text) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, ""))
    // A rough stem: "heists" and "heist" are the same word.
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

// The descriptions as TF-IDF vectors, built once per pool.
let index = null; // { list, vectors: Map(id → Map(word → weight)) }
const getIndex = () => {
  const list = getAllMovies();
  if (index?.list === list) return index;
  const docs = list.map((movie) => [movie.id, words(movie.description)]);
  const seenIn = new Map();
  docs.forEach(([, terms]) => new Set(terms).forEach((term) => seenIn.set(term, (seenIn.get(term) ?? 0) + 1)));
  const vectors = new Map();
  docs.forEach(([id, terms]) => {
    const counts = new Map();
    terms.forEach((term) => counts.set(term, (counts.get(term) ?? 0) + 1));
    const vector = new Map();
    let norm = 0;
    counts.forEach((count, term) => {
      // A word in only a handful of descriptions says more than one in many.
      const weight = (1 + Math.log(count)) * Math.log(list.length / (seenIn.get(term) ?? 1));
      vector.set(term, weight);
      norm += weight * weight;
    });
    norm = Math.sqrt(norm) || 1;
    vector.forEach((weight, term) => vector.set(term, weight / norm));
    vectors.set(id, vector);
  });
  index = { list, vectors };
  return index;
};

// How alike two descriptions are (0–1), and the words that carry it.
const storyOf = (a, b) => {
  if (!a || !b) return { value: 0, words: [] };
  let value = 0;
  const shared = [];
  a.forEach((weight, term) => {
    const other = b.get(term);
    if (other) {
      value += weight * other;
      shared.push([term, weight * other]);
    }
  });
  shared.sort((x, y) => y[1] - x[1]);
  return { value, words: shared.slice(0, 3).map(([term]) => term) };
};

// How similar, as a percent: the signals that say what the two films
// share (not quality), weighted, then scaled so a sequel-close match reads
// around 90% and a loose one around 40% (a share of 0.1 is no likeness at
// all; 0.65 about as alike as two different films get).
const SHARED = ["feel", "story", "themes", "genres", "tmdb", "cast", "era"];
const SHARED_WEIGHT = SHARED.reduce((sum, key) => sum + WEIGHTS[key], 0);
const SHARE_NONE = 0.1;
const SHARE_FULL = 0.65;
const percentOf = (signals) => {
  const share = SHARED.reduce((sum, key) => sum + WEIGHTS[key] * signals[key], 0) / SHARED_WEIGHT;
  const percent = (100 * (share - SHARE_NONE)) / (SHARE_FULL - SHARE_NONE);
  return Math.max(1, Math.min(99, Math.round(percent)));
};
const rounded = (signals) =>
  Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, Math.round(value * 100) / 100]));

const dimsOf = (movie) => movie.vibe?.dims ?? NEUTRAL_DIMS;
const themesOf = (movie) => movie.vibe?.themes ?? [];
const overlap = (a, b) => a.filter((item) => b.includes(item));

// The movies most like `movie`, best first: [{ id, score, percent,
// signals, shared, reasons }] — `percent` how similar (1–99), `signals`
// each part 0–1, `shared` what they have in common ({ story: words,
// themes, genres, cast }), `reasons` [{ key, value? }] the strongest parts,
// strongest first. `recommendedIds`: TMDB's picks for it.
export const getSimilar = (movie, { recommendedIds = [], count = 20 } = {}) => {
  const { list, vectors } = getIndex();
  const recommended = new Set(recommendedIds.map(String));
  const mine = {
    dims: dimsOf(movie),
    themes: themesOf(movie),
    genres: movie.genres ?? [],
    cast: (movie.cast ?? []).slice(0, 6),
    vector: vectors.get(movie.id) ?? new Map(words(movie.description).map((term) => [term, 1])),
  };
  // A non-pool movie's own words, normalised, so it compares like the rest.
  if (!vectors.has(movie.id)) {
    const norm = Math.sqrt(mine.vector.size) || 1;
    mine.vector.forEach((weight, term) => mine.vector.set(term, weight / norm));
  }

  const scored = list
    .filter((other) => other.id !== movie.id && (!movie.director || other.director !== movie.director))
    .map((other) => {
      const distance = Math.sqrt(dimsOf(other).reduce((sum, value, i) => sum + (value - mine.dims[i]) ** 2, 0));
      const story = storyOf(mine.vector, vectors.get(other.id));
      const sharedThemes = overlap(mine.themes, themesOf(other));
      const sharedGenres = overlap(mine.genres, other.genres ?? []);
      const sharedCast = overlap(mine.cast, (other.cast ?? []).slice(0, 6));
      const signals = {
        feel: 1 - distance / MAX_DISTANCE,
        story: story.value,
        themes: sharedThemes.length / Math.max(1, Math.min(mine.themes.length, themesOf(other).length)),
        genres: sharedGenres.length / Math.max(1, new Set([...mine.genres, ...(other.genres ?? [])]).size),
        tmdb: recommended.has(String(other.id)) ? 1 : 0,
        cast: sharedCast.length > 0 ? 1 : 0,
        era: movie.year && other.year ? Math.max(0, 1 - Math.abs(movie.year - other.year) / ERA_SPAN) : 0,
        rating: Math.max(0, Math.min(1, (weightedRating(other) - 6.5) / 2)),
      };
      const score = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + weight * signals[key], 0);
      const values = {
        story: story.words,
        themes: sharedThemes,
        genres: sharedGenres,
        cast: sharedCast.slice(0, 1),
      };
      const reasons = Object.keys(REASON_AT)
        .filter((key) => signals[key] >= REASON_AT[key] && (!values[key] || values[key].length > 0))
        .sort((a, b) => WEIGHTS[b] * signals[b] - WEIGHTS[a] * signals[a])
        .map((key) => (values[key] ? { key, value: values[key] } : { key }));
      return { id: other.id, score, percent: percentOf(signals), signals: rounded(signals), shared: values, reasons };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
};
