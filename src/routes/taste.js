import { Router } from "express";
import { z } from "zod";
import { run, toJSON, transaction } from "../db/index.js";
import { getTaste } from "../lib/library.js";
import { ensureMovie } from "../lib/movies.js";
import { leanings, MAX_PASSES, movieId } from "../lib/schemas.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/me/taste — the app's tasteStore: why you tiered things
// (aspects), what you skipped (passes), and onboarding's leanings.
const router = Router();

router.get("/", (req, res) => {
  res.json(getTaste(req.userId));
});

router.put("/leanings", validate(z.object({ leanings })), (req, res) => {
  run("UPDATE user_state SET leanings = ? WHERE user_id = ?", [
    toJSON(req.body.leanings),
    req.userId,
  ]);
  res.json({ leanings: req.body.leanings });
});

// Replace the aspects for one movie; an empty list removes them.
router.put(
  "/aspects/:movieId",
  validate(z.object({ movieId }), "params"),
  validate(z.object({ aspects: z.array(z.string().trim().min(1).max(40)).max(20) })),
  async (req, res) => {
    const { movieId: id } = req.params;
    await ensureMovie(id);
    const aspects = [...new Set(req.body.aspects)];
    if (aspects.length > 0) {
      run(
        `INSERT INTO taste_aspects (user_id, movie_id, aspects) VALUES (?, ?, ?)
         ON CONFLICT (user_id, movie_id) DO UPDATE SET aspects = excluded.aspects`,
        [req.userId, id, toJSON(aspects)],
      );
    } else {
      run("DELETE FROM taste_aspects WHERE user_id = ? AND movie_id = ?", [req.userId, id]);
    }
    res.json({ movieId: id, aspects });
  },
);

// A pass (swiped left / "not this one") — a weak negative signal. Keeps the
// newest MAX_PASSES, like the app.
router.post("/passes", validate(z.object({ movieId })), async (req, res) => {
  await ensureMovie(req.body.movieId);
  const at = Date.now();
  transaction(() => {
    run(
      `INSERT INTO taste_passes (user_id, movie_id, at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, movie_id) DO UPDATE SET at = excluded.at`,
      [req.userId, req.body.movieId, at],
    );
    run(
      `DELETE FROM taste_passes WHERE user_id = :me AND movie_id NOT IN (
         SELECT movie_id FROM taste_passes WHERE user_id = :me ORDER BY at DESC LIMIT :max)`,
      { me: req.userId, max: MAX_PASSES },
    );
  });
  res.status(201).json({ movieId: req.body.movieId, at });
});

router.delete("/", (req, res) => {
  transaction(() => {
    run("DELETE FROM taste_aspects WHERE user_id = ?", [req.userId]);
    run("DELETE FROM taste_passes WHERE user_id = ?", [req.userId]);
    run("UPDATE user_state SET leanings = NULL WHERE user_id = ?", [req.userId]);
  });
  res.status(204).end();
});

export default router;
