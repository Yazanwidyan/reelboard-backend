import { getAllMovies, getMovieById } from "./movies.js";

// Collections — a franchise, a director's films, an actor's films, the best
// of a decade or a genre — worked out from the pool (lib/movies.js),
// the same way the app used to work them out from the catalog it
// downloaded. The app no longer has the pool, so it gets collections from
// here, as definitions: { id, type, title, movieIds }. XP (lib/xp.js) counts
// finished collections from the same definitions, so the app's instant XP
// and the server's agree.
//
// The rules:
//   franchise, director   2+ pool films
//   actor                 3+ pool films in the top-billed cast
//   decade, genre         every one, trimmed to the 15 best-ranked films
//                         ("Best of the 1990s") when there are more
// Ids are `${type}-${slugify(title)}`, as the app has always named them.

const MIN_COLLECTION_SIZE = 2;
const MIN_ACTOR_COLLECTION_SIZE = 3;
const CURATED_SIZE = 15;
// Only finished franchises, directors and actors of 3+ films earn XP.
export const XP_COLLECTION_TYPES = ["franchise", "director", "actor"];
export const XP_COLLECTION_MIN_SIZE = 3;

export const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const groupBy = (movies, keysOf) => {
  const map = new Map();
  movies.forEach((movie) => {
    [keysOf(movie)].flat().forEach((key) => {
      if (key == null) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(movie);
    });
  });
  return map;
};

const byYear = (a, b) => a.year - b.year;
const decadeLabel = (year) => `${Math.floor(year / 10) * 10}s`;

const define = (type, title, movies) => ({
  id: `${type}-${slugify(title)}`,
  type,
  title,
  movieIds: movies.map((movie) => movie.id),
});

// Best-ranked first, trimmed to CURATED_SIZE; the title says so only when
// it was trimmed.
const curated = (type, label, bestOfLabel, movies) => {
  const sorted = [...movies].sort((a, b) => a.rank - b.rank);
  const trimmed = sorted.length > CURATED_SIZE;
  return define(type, trimmed ? bestOfLabel : label, trimmed ? sorted.slice(0, CURATED_SIZE) : sorted);
};

const build = (movies) => {
  const franchise = [...groupBy(movies, (movie) => movie.franchise).entries()]
    .filter(([, list]) => list.length >= MIN_COLLECTION_SIZE)
    .map(([name, list]) => define("franchise", name, [...list].sort(byYear)));
  const director = [...groupBy(movies, (movie) => movie.director).entries()]
    .filter(([, list]) => list.length >= MIN_COLLECTION_SIZE)
    .map(([name, list]) => define("director", name, [...list].sort(byYear)));
  const actor = [...groupBy(movies, (movie) => movie.cast ?? []).entries()]
    .filter(([, list]) => list.length >= MIN_ACTOR_COLLECTION_SIZE)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, list]) => define("actor", name, [...list].sort(byYear)));
  const decade = [...groupBy(movies, (movie) => (movie.year ? decadeLabel(movie.year) : null)).entries()]
    .filter(([, list]) => list.length >= MIN_COLLECTION_SIZE)
    .map(([label, list]) => curated("decade", label, `Best of the ${label}`, list));
  const genre = [...groupBy(movies, (movie) => movie.genres).entries()]
    .filter(([, list]) => list.length >= MIN_COLLECTION_SIZE)
    .map(([label, list]) => curated("genre", label, `Best of ${label}`, list));

  // Two names can slug the same; the first keeps the id.
  const byId = new Map();
  [...franchise, ...director, ...actor, ...decade, ...genre].forEach((collection) => {
    if (!byId.has(collection.id)) byId.set(collection.id, collection);
  });
  const all = [...byId.values()];
  const byMovie = new Map();
  all.forEach((collection) =>
    collection.movieIds.forEach((id) => {
      if (!byMovie.has(id)) byMovie.set(id, []);
      byMovie.get(id).push(collection);
    }),
  );
  return { all, byId, byMovie };
};

// The pool doesn't change while the server runs, so they're built once.
let built = null;
const collections = () => {
  built ??= build(getAllMovies());
  return built;
};

export const getCollection = (id) => collections().byId.get(id) ?? null;

export const getCollectionsForMovie = (movieId) => collections().byMovie.get(movieId) ?? [];

// The ones finishing earns XP for, as lists of movie ids.
export const getXPCollections = () =>
  collections()
    .all.filter(
      (collection) =>
        XP_COLLECTION_TYPES.includes(collection.type) &&
        collection.movieIds.length >= XP_COLLECTION_MIN_SIZE,
    )
    .map((collection) => collection.movieIds);

// ---- What the app gets -------------------------------------------------------------

// Yours: every collection you've unlocked, and the ones you've started —
// with a franchise, decade or genre one film is a start; with a director
// or an actor it takes two (everyone's seen one film by hundreds of them).
// Every finished collection is in here, and so is every one a single watch
// could finish, so the app's XP for a watch agrees with the server's.
export const getPersonalCollections = (watchedIds, unlockedIds = []) => {
  const watched = new Set(watchedIds);
  const found = new Map();
  unlockedIds.forEach((id) => {
    const collection = getCollection(id);
    if (collection) found.set(id, collection);
  });
  const counts = new Map();
  watched.forEach((movieId) =>
    getCollectionsForMovie(movieId).forEach((collection) =>
      counts.set(collection, (counts.get(collection) ?? 0) + 1),
    ),
  );
  counts.forEach((count, collection) => {
    const needed = collection.type === "director" || collection.type === "actor" ? 2 : 1;
    if (count >= needed) found.set(collection.id, collection);
  });
  return [...found.values()];
};

// To browse and to suggest from: the best-known franchises, directors and
// actors (by their films' TMDB votes), and every decade and genre.
const FEATURED_PER_TYPE = 30;
const votesOf = (collection) =>
  collection.movieIds.reduce((sum, id) => sum + (getMovieById(id)?.details?.votes ?? 0), 0);
let featured = null;
export const getFeaturedCollections = () => {
  if (!featured) {
    const { all } = collections();
    const top = (type) =>
      all
        .filter((collection) => collection.type === type)
        .map((collection) => ({ collection, votes: votesOf(collection) }))
        .sort((a, b) => b.votes - a.votes)
        .slice(0, FEATURED_PER_TYPE)
        .map(({ collection }) => collection);
    featured = [
      ...top("franchise"),
      ...top("director"),
      ...top("actor"),
      ...all.filter((collection) => collection.type === "decade" || collection.type === "genre"),
    ];
  }
  return featured;
};

// A movie as collections show it: enough for a poster, a title and the
// collection's own sums — not the plot, vibe or details the movie page and
// the swipe cards need (the app fetches the full movie when it opens one).
export const toCard = (movie) => ({
  id: movie.id,
  title: movie.title,
  year: movie.year,
  rating: movie.rating,
  runtime: movie.runtime,
  genres: movie.genres,
  director: movie.director,
  cast: movie.cast,
  franchise: movie.franchise,
  poster: movie.poster,
  rank: movie.rank,
  partial: true,
});

// Collections as a response sends them: the definitions, plus cards for
// the first few films of each (enough for its collage) — or all of them.
export const withCards = (list, { cardsPer = 4 } = {}) => {
  const ids = new Set(list.flatMap((collection) => collection.movieIds.slice(0, cardsPer)));
  return {
    collections: list,
    cards: [...ids].map(getMovieById).filter(Boolean).map(toCard),
  };
};

// A response's `movies` and `collections` together: `movies` (full ones)
// plus cards for the collections' films that aren't among them.
export const attachCollections = (movies, list, options) => {
  const { collections: definitions, cards } = withCards(list, options);
  const have = new Set(movies.map((movie) => movie.id));
  return { movies: [...movies, ...cards.filter((card) => !have.has(card.id))], collections: definitions };
};

// For tests: forget what was built (the pool changed).
export const resetCollections = () => {
  built = null;
  featured = null;
};
