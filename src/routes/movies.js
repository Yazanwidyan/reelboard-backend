import { Router } from "express";
import { z } from "zod";
import { all, catalogMeta } from "../db/index.js";
import { attachCollections, getCollectionsForMovie, getSagasForPeople, SAGA } from "../lib/collections.js";
import { notFound } from "../lib/errors.js";
import {
  applyPreferenceFilters,
  DECADE_RANGES,
  ensureMovie,
  ensureMovies,
  getAllMovies,
  getGenres,
  getMovieById,
  matchesSearch,
  moviesFor,
  RUNTIME_RANGES,
  toLean,
} from "../lib/movies.js";
import { movieId, pagination } from "../lib/schemas.js";
import { findSimilar } from "../lib/similar.js";
import { imageUrl, tmdbGet } from "../lib/tmdb.js";
import { GENRE_IDS, franchiseOf, toSummary } from "../lib/tmdbMovies.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/movies.
//   The pool (public): GET /, /meta, /reels — see lib/movies.js. The app
//   doesn't download the pool; it gets candidates (GET /api/me/candidates)
//   and the movies each response mentions.
//   Everything on TMDB (signed in, rate-limited): search, lists, discover,
//   any movie's page, similar movies, where to watch, collections.
const router = Router();

// TMDB answers stay fresh in the server's memory for this long.
const HOUR = 60 * 60 * 1000;
const tmdbRoute = [requireAuth, rateLimit({ windowMs: 60 * 1000, max: 120 })];
// TMDB pages past 500 aren't served.
const MAX_PAGE = 500;
const tmdbPage = z.coerce.number().int().min(1).max(MAX_PAGE).default(1);
const region = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());

// A page of TMDB movie results, as summaries.
const toPage = (data, page) => ({
  results: (data?.results ?? []).filter((movie) => !movie.adult).map(toSummary),
  page,
  totalPages: Math.min(data?.total_pages ?? 0, MAX_PAGE),
  totalResults: data?.total_results ?? 0,
});

const SORTS = {
  rank: (a, b) => a.rank - b.rank,
  rating: (a, b) => a.rating - b.rating || b.rank - a.rank,
  year: (a, b) => a.year - b.year || b.rank - a.rank,
  runtime: (a, b) => a.runtime - b.runtime || b.rank - a.rank,
  title: (a, b) => a.title.localeCompare(b.title),
};

const listSchema = z.object({
  q: z.string().max(100).optional(),
  // ?genres=Drama,Comedy — matches movies with ANY of them, like the app.
  genres: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").map((g) => g.trim()).filter(Boolean) : [])),
  decade: z.enum(Object.keys(DECADE_RANGES)).optional(),
  runtime: z.enum(Object.keys(RUNTIME_RANGES)).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  director: z.string().max(100).optional(),
  // ?ids=m1,m2,m3 — fetch specific movies (e.g. a board's), in that order.
  ids: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").map((id) => id.trim()) : null)),
  sort: z.enum(Object.keys(SORTS)).default("rank"),
  order: z.enum(["asc", "desc"]).optional(),
  ...pagination,
});

// GET /api/movies — search, filter, sort and page through the catalog.
router.get("/", validate(listSchema, "query"), (req, res) => {
  const { q, genres, decade, runtime, minRating, director, ids, sort, order, page, limit } =
    req.validQuery;

  let movies = ids
    ? ids.map(getMovieById).filter(Boolean)
    : getAllMovies();
  movies = applyPreferenceFilters(movies, { genres, decade, runtime, minRating });
  if (q) movies = movies.filter((movie) => matchesSearch(movie, q));
  if (director) {
    const needle = director.toLowerCase();
    movies = movies.filter((movie) => movie.director?.toLowerCase() === needle);
  }
  if (!ids) {
    // Rank reads best ascending; everything else defaults to high → low.
    const direction = (order ?? (sort === "rank" || sort === "title" ? "asc" : "desc")) === "asc" ? 1 : -1;
    movies = [...movies].sort((a, b) => direction * SORTS[sort](a, b));
  }

  const total = movies.length;
  res.json({
    movies: movies.slice((page - 1) * limit, page * limit).map(toLean),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  });
});

// GET /api/movies/meta — filter options and Taste DNA vocabulary.
router.get("/meta", (req, res) => {
  res.json({
    genres: getGenres(),
    decades: Object.keys(DECADE_RANGES),
    runtimes: Object.keys(RUNTIME_RANGES),
    dimensions: catalogMeta.dimensions,
    themes: catalogMeta.themes,
  });
});

// Reel clips in the order they were listed in the catalog.
const listClips = () =>
  all('SELECT movie_id, youtube_id, start, "end" FROM reel_clips ORDER BY rowid').map((row) => ({
    movieId: row.movie_id,
    youtubeId: row.youtube_id,
    start: row.start,
    end: row.end,
  }));

// GET /api/movies/reels — trailer clips for the Reels feed, with their
// movies.
router.get("/reels", (req, res) => {
  const clips = listClips();
  res.json({
    clips,
    clipSeconds: catalogMeta.clipSeconds,
    movies: clips.map((clip) => getMovieById(clip.movieId)).filter(Boolean).map(toLean),
  });
});

// ---- Everything on TMDB --------------------------------------------------------

// GET /api/movies/search?q=matrix&page=1 — any movie, by title.
router.get(
  "/search",
  tmdbRoute,
  validate(
    z.object({
      q: z.string().trim().min(1).max(100),
      page: tmdbPage,
      year: z.coerce.number().int().min(1870).max(2100).optional(),
    }),
    "query",
  ),
  async (req, res) => {
    const { q, page, year } = req.validQuery;
    const data = await tmdbGet(
      "/search/movie",
      { query: q, page, primary_release_year: year, include_adult: "false", language: "en-US" },
      { ttl: 10 * 60 * 1000 },
    );
    res.json(toPage(data, page));
  },
);

// GET /api/movies/lists/:kind — TMDB's lists. `region` (two letters) for
// what's in cinemas there.
const LISTS = {
  trending: "/trending/movie/week",
  popular: "/movie/popular",
  "now-playing": "/movie/now_playing",
  upcoming: "/movie/upcoming",
  "top-rated": "/movie/top_rated",
};
router.get(
  "/lists/:kind",
  tmdbRoute,
  validate(z.object({ kind: z.enum(Object.keys(LISTS)) }), "params"),
  validate(z.object({ page: tmdbPage, region: region.optional() }), "query"),
  async (req, res) => {
    const { page, region: country } = req.validQuery;
    const data = await tmdbGet(
      LISTS[req.params.kind],
      { page, region: country, language: "en-US" },
      { ttl: HOUR },
    );
    res.json(toPage(data, page));
  },
);

// GET /api/movies/discover — browse by genre, decade and rating, sorted by
// popularity, rating or release date.
const DISCOVER_SORTS = {
  popular: { sort_by: "popularity.desc" },
  rating: { sort_by: "vote_average.desc", "vote_count.gte": 300 },
  newest: { sort_by: "primary_release_date.desc", "vote_count.gte": 20 },
};
router.get(
  "/discover",
  tmdbRoute,
  validate(
    z.object({
      genre: z.enum(Object.keys(GENRE_IDS)).optional(),
      decade: z.enum(Object.keys(DECADE_RANGES)).optional(),
      minRating: z.coerce.number().min(0).max(10).optional(),
      sort: z.enum(Object.keys(DISCOVER_SORTS)).default("popular"),
      page: tmdbPage,
    }),
    "query",
  ),
  async (req, res) => {
    const { genre, decade, minRating, sort, page } = req.validQuery;
    const range = DECADE_RANGES[decade ?? "Any"];
    const today = new Date().toISOString().slice(0, 10);
    const data = await tmdbGet(
      "/discover/movie",
      {
        ...DISCOVER_SORTS[sort],
        with_genres: genre ? GENRE_IDS[genre] : undefined,
        "primary_release_date.gte": range ? `${Math.max(range[0], 1870)}-01-01` : undefined,
        "primary_release_date.lte": range
          ? `${Math.min(range[1], 2100)}-12-31`
          : sort === "newest"
            ? today
            : undefined,
        "vote_average.gte": minRating,
        // Feature films: no shorts or music videos.
        "with_runtime.gte": 40,
        include_adult: "false",
        page,
        language: "en-US",
      },
      { ttl: HOUR },
    );
    res.json(toPage(data, page));
  },
);

// GET /api/movies/batch?ids=603,550 — several movies at once (up to 50),
// from TMDB if the server doesn't have them yet. Unknown ids are left out.
router.get(
  "/batch",
  tmdbRoute,
  validate(
    z.object({
      ids: z
        .string()
        .transform((value) => [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))])
        .pipe(z.array(movieId).min(1).max(50)),
    }),
    "query",
  ),
  async (req, res) => {
    res.json({ movies: (await ensureMovies(req.validQuery.ids)).map(toLean) });
  },
);

// GET /api/movies/collections/:id — a TMDB collection ("The Dark Knight
// Collection"): every film in it, oldest first.
router.get(
  "/collections/:id",
  tmdbRoute,
  validate(z.object({ id: z.string().regex(/^\d{1,10}$/) }), "params"),
  async (req, res) => {
    const data = await tmdbGet(
      `/collection/${req.params.id}`,
      { language: "en-US" },
      { ttl: 24 * HOUR },
    );
    if (!data) throw notFound("No such collection");
    res.json({
      collection: {
        id: data.id,
        name: data.name,
        franchise: franchiseOf(data),
        overview: data.overview || "",
        poster: imageUrl(data.poster_path, "w500"),
        backdrop: imageUrl(data.backdrop_path, "w1280"),
        movies: (data.parts ?? [])
          .filter((movie) => !movie.adult)
          .sort((a, b) => (a.release_date || "9999").localeCompare(b.release_date || "9999"))
          .map(toSummary),
      },
    });
  },
);

const idParam = validate(z.object({ id: movieId }), "params");

// GET /api/movies/:id — any movie's page: everything, including cast with
// photos, directors and writers — and the sagas it's in, plus the sagas of
// the people in it (tapping Al Pacino opens his), with cards for their
// first films.
router.get("/:id", tmdbRoute, idParam, async (req, res) => {
  const { fetchedAt, ...movie } = await ensureMovie(req.params.id);
  const people = [
    movie.director,
    ...(movie.details?.directors ?? []).map((person) => person.name),
    ...(movie.cast ?? []),
    ...(movie.details?.castDetails ?? []).map((person) => person.name),
  ];
  const sagas = getCollectionsForMovie(movie.id).filter((collection) => collection.type === SAGA);
  const list = [...new Set([...sagas, ...getSagasForPeople(people)])];
  res.json({ movie, ...attachCollections([], list) });
});

// GET /api/movies/:id/similar — TMDB's recommendations for it (or, without
// any, its similar movies).
router.get("/:id/similar", tmdbRoute, idParam, async (req, res) => {
  const options = [{ language: "en-US" }, { ttl: 24 * HOUR }];
  const recommended = await tmdbGet(`/movie/${req.params.id}/recommendations`, ...options);
  const data = recommended?.results?.length
    ? recommended
    : await tmdbGet(`/movie/${req.params.id}/similar`, ...options);
  res.json(toPage(data, 1));
});

// GET /api/movies/:id/like?count=20 — "More like this": the films most like
// it — what its fans went on to like and what they're about (TMDB's
// recommendations and keywords), with feel, genres, story, cast and era
// behind them (lib/similar.js) — best first, each with how similar and
// why, and the movies themselves. Without TMDB it still answers, from the
// pool alone.
router.get(
  "/:id/like",
  tmdbRoute,
  idParam,
  validate(
    z.object({
      count: z.coerce.number().int().min(1).max(40).default(20),
      // "true": keep the director's other films (the movie page has "Also by").
      sameDirector: z.enum(["true", "false"]).default("false"),
    }),
    "query",
  ),
  async (req, res) => {
    const movie = await ensureMovie(req.params.id);
    const similar = await findSimilar(movie, {
      count: req.validQuery.count,
      sameDirector: req.validQuery.sameDirector === "true",
    });
    // The movie itself comes too, whole — it may have been only a card.
    res.json({ similar, movies: moviesFor([movie.id, ...similar.map((item) => item.id)]) });
  },
);

// GET /api/movies/:id/providers?region=US — where to watch it there:
// stream / rent / buy / free. The data is JustWatch's (via TMDB), and its
// terms ask for JustWatch to be credited wherever it's shown.
const PROVIDER_KINDS = { flatrate: "stream", free: "free", ads: "ads", rent: "rent", buy: "buy" };
router.get(
  "/:id/providers",
  tmdbRoute,
  idParam,
  validate(z.object({ region: region.default("US") }), "query"),
  async (req, res) => {
    const data = await tmdbGet(`/movie/${req.params.id}/watch/providers`, {}, { ttl: 6 * HOUR });
    const here = data?.results?.[req.validQuery.region] ?? null;
    const providers = Object.fromEntries(
      Object.entries(PROVIDER_KINDS).map(([kind, name]) => [
        name,
        [...(here?.[kind] ?? [])]
          .sort((a, b) => a.display_priority - b.display_priority)
          .map((provider) => ({
            id: provider.provider_id,
            name: provider.provider_name,
            logo: imageUrl(provider.logo_path, "w92"),
          })),
      ]),
    );
    res.json({
      region: req.validQuery.region,
      link: here?.link ?? null,
      ...providers,
      source: "JustWatch",
    });
  },
);

export default router;
