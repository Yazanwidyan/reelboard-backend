import { readSagas } from "../db/index.js";
import { readCuration } from "./curation.js";
import { getAllMovies, getMovieById } from "./movies.js";

// Collections, as definitions the app gets: { id, type, title, movieIds }.
// Ranks (lib/ranks.js) count the sagas from the same definitions, so the
// app's instant ranks and the server's agree. Two kinds:
//
//   sagas    THE collections — the hand-made ones in data/curation.json
//            ("Potterhead", "Assembled", "King of the World"…), turned into
//            films by `npm run build-pool`. Each also has a `kind`
//            (franchise / studio / theme / director / actor), a `subtitle`,
//            `ranks` ([{ title, at }], `at` a film count — you climb them as
//            you watch) and `art` ({ backdrop } or { photo }). They're what
//            Library, Home, badges, trophies and XP count.
//   lists    worked out from the pool, for browsing only ("More from
//            Christopher Nolan"): franchises (3+ films), directors (2+),
//            actors (3+ top-billed), decades and genres (trimmed to the 15
//            best-ranked: "Best of the 1990s"). Never achievements.
// List ids are `${type}-${slugify(title)}`, as the app has always named
// them; sagas' are `saga-${id}`.

const MIN_FRANCHISE_SIZE = 3;
const MIN_COLLECTION_SIZE = 2;
const MIN_ACTOR_COLLECTION_SIZE = 3;
const CURATED_SIZE = 15;
export const SAGA = "saga";

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

const build = (movies, sagas) => {
  const franchise = [...groupBy(movies, (movie) => movie.franchise).entries()]
    .filter(([, list]) => list.length >= MIN_FRANCHISE_SIZE)
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

  // Two names can slug the same; the first keeps the id. Sagas first.
  const byId = new Map();
  [...sagas, ...franchise, ...director, ...actor, ...decade, ...genre].forEach((collection) => {
    if (!byId.has(collection.id)) byId.set(collection.id, collection);
  });
  const all = [...byId.values()];
  const sagaList = all.filter((collection) => collection.type === SAGA);
  const byMovie = new Map();
  all.forEach((collection) =>
    collection.movieIds.forEach((id) => {
      if (!byMovie.has(id)) byMovie.set(id, []);
      byMovie.get(id).push(collection);
    }),
  );
  return { all, byId, byMovie, sagas: sagaList };
};

// The pool and the sagas don't change while the server runs, so they're
// built once. Sagas whose films aren't all in the pool any more lose those
// films (the pool was rebuilt without them).
let built = null;
// Bumped whenever they're rebuilt, so cached responses know they're stale.
let version = 0;
export const collectionsVersion = () => version;

// Who an actor's or a director's saga is about ("Al Pacino"), so a movie
// page can point their name at it. build-pool stores it as `person`; sagas
// built before that get it from data/curation.json.
const curatedPeople = () => {
  try {
    return new Map(
      (readCuration().sagas ?? []).map((item) => [
        `saga-${item.id}`,
        item.from?.actor ?? item.from?.director ?? item.person ?? null,
      ]),
    );
  } catch {
    return new Map();
  }
};

const collections = () => {
  if (!built) {
    const movies = getAllMovies();
    const inPool = new Set(movies.map((movie) => movie.id));
    const people = curatedPeople();
    const sagas = readSagas()
      .map((saga) => ({
        ...saga,
        person: saga.person ?? people.get(saga.id) ?? null,
        movieIds: saga.movieIds.filter((id) => inPool.has(id)),
      }))
      .filter((saga) => saga.movieIds.length > 0);
    built = build(movies, sagas);
  }
  return built;
};

export const getSagas = () => collections().sagas;

// The ranks reached with `watchedCount` of a saga's films: [{ title, at }].
export const ranksReached = (saga, watchedCount) =>
  (saga.ranks ?? []).filter((rank) => watchedCount >= rank.at);

export const getCollection = (id) => collections().byId.get(id) ?? null;

export const getCollectionsForMovie = (movieId) => collections().byMovie.get(movieId) ?? [];

// The sagas about any of these people: an actor's, a director's.
export const getSagasForPeople = (names) => {
  const wanted = new Set(names.filter(Boolean));
  return getSagas().filter((saga) => saga.person && wanted.has(saga.person));
};

// The sagas these watched movies finish — a profile's trophies.
export const getFinishedCollections = (watchedIds) => {
  const watched = new Set(watchedIds);
  return getSagas().filter((saga) => saga.movieIds.every((id) => watched.has(id)));
};

// ---- What the app gets -------------------------------------------------------------

// Yours: every saga you've started (one film is a start) or chosen to
// track, and any other collection you've chosen to track. Every saga with a
// film watched is in here, so the app's ranks agree with the server's.
export const getPersonalCollections = (watchedIds, unlockedIds = []) => {
  const watched = new Set(watchedIds);
  const found = new Map();
  unlockedIds.forEach((id) => {
    const collection = getCollection(id);
    if (collection) found.set(id, collection);
  });
  getSagas()
    .filter((saga) => saga.movieIds.some((id) => watched.has(id)))
    .forEach((saga) => found.set(saga.id, saga));
  return [...found.values()];
};

// To browse and to suggest from: every saga, in the curation's order.
export const getFeaturedCollections = () => getSagas();

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
  // How many rated it on TMDB — the app weighs the rating by it.
  votes: movie.details?.votes ?? 0,
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

// Forget what was built (the pool or the sagas changed — the admin site, or
// tests).
export const resetCollections = () => {
  built = null;
  version += 1;
};
