import { Router } from "express";
import { z } from "zod";
import { all, catalogMeta } from "../db/index.js";
import { notFound } from "../lib/errors.js";
import {
  applyPreferenceFilters,
  DECADE_RANGES,
  getAllMovies,
  getGenres,
  getMovieById,
  matchesSearch,
  RUNTIME_RANGES,
} from "../lib/movies.js";
import { pagination } from "../lib/schemas.js";
import { validate } from "../middleware/validate.js";

const router = Router();

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
    movies: movies.slice((page - 1) * limit, page * limit),
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

// GET /api/movies/catalog — the whole catalog in one response: every
// movie (with cast, details and vibe), the Reels clips, and the Taste DNA
// vocabulary. The app loads this once at sign-in instead of bundling movies.
router.get("/catalog", (req, res) => {
  res.json({
    movies: getAllMovies(),
    reelClips: listClips(),
    clipSeconds: catalogMeta.clipSeconds,
    dimensions: catalogMeta.dimensions,
    themes: catalogMeta.themes,
  });
});

// GET /api/movies/reels — trailer clips for the Reels feed.
router.get("/reels", (req, res) => {
  const clips = listClips().map((clip) => ({
    ...clip,
    thumbnail: `https://img.youtube.com/vi/${clip.youtubeId}/hqdefault.jpg`,
    movie: getMovieById(clip.movieId),
  }));
  res.json({ clips, clipSeconds: catalogMeta.clipSeconds });
});

router.get("/:id", (req, res) => {
  const movie = getMovieById(req.params.id);
  if (!movie) throw notFound("No such movie");
  res.json({ movie });
});

export default router;
