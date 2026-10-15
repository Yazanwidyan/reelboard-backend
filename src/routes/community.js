import { Router } from "express";
import { z } from "zod";
import { all, get } from "../db/index.js";
import { moviesOutsidePool } from "../lib/movies.js";
import { movieId, TIERS } from "../lib/schemas.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/community — what everyone on ReelBoard thinks, as totals
// only: never who tiered what.
const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
// "Community favorites" needs at least this many tiers, so one person's S
// doesn't make a movie everyone's favourite.
export const MIN_FAVORITE_TIERS = 2;

// GET /api/community/movies/:movieId — how everyone tiered it.
router.get("/movies/:movieId", validate(z.object({ movieId }), "params"), (req, res) => {
  // Totals of what people saved — a movie nobody has is all zeros.
  const { movieId: id } = req.params;
  const tiers = Object.fromEntries(TIERS.map((key) => [key, 0]));
  for (const row of all(
    "SELECT tier, COUNT(*) AS n FROM watched WHERE movie_id = ? AND tier IS NOT NULL GROUP BY tier",
    [id],
  )) {
    tiers[row.tier] = row.n;
  }
  res.json({
    movieId: id,
    watchedCount: get("SELECT COUNT(*) AS n FROM watched WHERE movie_id = ?", [id]).n,
    watchlistCount: get("SELECT COUNT(*) AS n FROM watchlist WHERE movie_id = ?", [id]).n,
    tieredCount: Object.values(tiers).reduce((sum, n) => sum + n, 0),
    tiers,
  });
});

// GET /api/community/trending — the Discover rows:
//   trending   most watched + saved in the last `days`
//   favorites  highest share of S and A tiers, of all time
router.get(
  "/trending",
  validate(
    z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
    "query",
  ),
  (req, res) => {
    const { days, limit } = req.validQuery;
    const since = Date.now() - days * DAY_MS;
    const trending = all(
      `SELECT movie_id, COUNT(*) AS n FROM (
         SELECT movie_id FROM watched WHERE watched_at > :since
         UNION ALL
         SELECT movie_id FROM watchlist WHERE added_at > :since
       ) GROUP BY movie_id ORDER BY n DESC, movie_id LIMIT :limit`,
      { since, limit },
    ).map((row) => ({ movieId: row.movie_id, count: row.n }));
    const favorites = all(
      `SELECT movie_id, COUNT(*) AS total,
              SUM(tier IN ('S', 'A')) AS loved, SUM(tier = 'S') AS s
       FROM watched WHERE tier IS NOT NULL
       GROUP BY movie_id HAVING total >= :min
       ORDER BY loved * 1.0 / total DESC, s DESC, total DESC, movie_id
       LIMIT :limit`,
      { min: MIN_FAVORITE_TIERS, limit },
    ).map((row) => ({
      movieId: row.movie_id,
      tieredCount: row.total,
      lovedShare: Math.round((row.loved / row.total) * 100) / 100,
    }));
    res.json({
      days,
      trending,
      favorites,
      movies: moviesOutsidePool([...trending, ...favorites].map((row) => row.movieId)),
    });
  },
);

export default router;
