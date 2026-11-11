import { Router } from "express";
import { z } from "zod";
import { get, run, toJSON } from "../db/index.js";
import { getMovieById } from "../lib/movies.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/me/picks — every pick for tonight someone takes, with
// why the engine suggested it, and what came of it: what tells whether the
// taste engine works, and which of its signals to trust (the admin
// dashboard's "Picks by type").
//   POST /           a pick taken: { movieId, source, match?, signals? }
//                    — `source` why it was suggested (taste / collection /
//                    watchlist / onboarding / other), `match` the engine's
//                    0–100, `signals` [{ key, value }] what moved it.
//   POST /outcome    what came of the latest open pick of a film:
//                    { movieId, outcome: loved | fine | not | not_watched |
//                    dismissed, tier? }.
// Whether the film's Taste DNA was hand-tagged or estimated is noted here.
// A pick with no outcome after a few days counts as ignored.
const router = Router();

const movieId = z.string().trim().min(1).max(32);
const SOURCES = ["taste", "collection", "watchlist", "onboarding", "other"];
const OUTCOMES = ["loved", "fine", "not", "not_watched", "dismissed"];

router.post(
  "/",
  validate(
    z.object({
      movieId,
      source: z.enum(SOURCES).catch("other"),
      match: z.number().int().min(0).max(100).nullable().optional(),
      signals: z
        .array(z.object({ key: z.string().max(32), value: z.number() }))
        .max(20)
        .optional(),
    }),
  ),
  (req, res) => {
    const { movieId: id, source, match, signals = [] } = req.body;
    run(
      `INSERT INTO picks (user_id, movie_id, source, match, hand_dna, signals, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.userId,
        id,
        source,
        match ?? null,
        getMovieById(id)?.vibeSource === "hand" ? 1 : 0,
        toJSON(signals.map(({ key, value }) => ({ key, value: Math.round(value * 100) / 100 }))),
        Date.now(),
      ],
    );
    res.status(204).end();
  },
);

router.post(
  "/outcome",
  validate(z.object({ movieId, outcome: z.enum(OUTCOMES), tier: z.enum(["S", "A", "B", "C", "D", "F"]).optional() })),
  (req, res) => {
    const { movieId: id, outcome, tier } = req.body;
    const open = get(
      "SELECT id FROM picks WHERE user_id = ? AND movie_id = ? AND outcome IS NULL ORDER BY id DESC LIMIT 1",
      [req.userId, id],
    );
    if (open) {
      run("UPDATE picks SET outcome = ?, tier = ?, outcome_at = ? WHERE id = ?", [outcome, tier ?? null, Date.now(), open.id]);
    }
    res.status(204).end();
  },
);

export default router;
