import { Router } from "express";
import { z } from "zod";
import { fromJSON, get, run, toJSON, transaction } from "../db/index.js";
import { logActivity, retractActivity } from "../lib/activity.js";
import { notFound } from "../lib/errors.js";
import {
  completeChallengeFor,
  getUserState,
  getWatchedEntry,
  listWatched,
  listWatchlist,
  toPick,
} from "../lib/library.js";
import { assertMovie, generateRecommendations } from "../lib/movies.js";
import { collectionId, movieId, tier, timestamp } from "../lib/schemas.js";
import { updateLevel } from "../lib/xp.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/me — the app's movieStore, server-side.
const router = Router();

const movieParam = z.object({ movieId });

// GET /api/me/library — the whole movieStore in one response: watchlist,
// watched, tonight's pick and manually unlocked collections.
router.get("/library", (req, res) => {
  const state = getUserState(req.userId);
  res.json({
    bucketList: listWatchlist(req.userId),
    watched: listWatched(req.userId),
    ...toPick(state),
    unlockedCollections: fromJSON(state.unlocked_collections, []),
  });
});

// Deletes succeed even when there's nothing left to delete: the app may
// send the same removal twice (a retry, or another device got there first),
// and either way the movie is gone.

// ---- Watchlist (movieStore.bucketList) -----------------------------------

router.get("/watchlist", (req, res) => {
  res.json({ watchlist: listWatchlist(req.userId) });
});

router.post("/watchlist", validate(z.object({ movieId })), (req, res) => {
  const { movieId: id } = req.body;
  assertMovie(id);
  const existing = get("SELECT added_at FROM watchlist WHERE user_id = ? AND movie_id = ?", [
    req.userId,
    id,
  ]);
  if (existing) return res.json({ entry: { movieId: id, addedAt: existing.added_at } });

  const addedAt = Date.now();
  transaction(() => {
    run("INSERT INTO watchlist (user_id, movie_id, added_at) VALUES (?, ?, ?)", [
      req.userId,
      id,
      addedAt,
    ]);
    logActivity(req.userId, "watchlist", { movieId: id });
  });
  res.status(201).json({ entry: { movieId: id, addedAt } });
});

router.delete("/watchlist/:movieId", validate(movieParam, "params"), (req, res) => {
  const { changes } = run("DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?", [
    req.userId,
    req.params.movieId,
  ]);
  if (changes) retractActivity(req.userId, "watchlist", req.params.movieId);
  res.status(204).end();
});

router.delete("/watchlist", (req, res) => {
  run("DELETE FROM watchlist WHERE user_id = ?", [req.userId]);
  res.status(204).end();
});

// ---- Watched (movieStore.watched) ----------------------------------------

router.get("/watched", (req, res) => {
  res.json({ watched: listWatched(req.userId) });
});

const markWatchedSchema = z.object({
  movieId,
  tier: tier.nullable().optional(),
  // When you watched it — for logging a movie late. Never in the future.
  watchedAt: timestamp.optional(),
});

// Marking something watched also takes it off the watchlist, clears it as
// tonight's pick, and completes the active challenge if it was the target —
// same as the app's toggleWatched + checkAutoCompletion.
router.post("/watched", validate(markWatchedSchema), (req, res) => {
  const { movieId: id, tier: chosenTier = null, watchedAt } = req.body;
  assertMovie(id);
  const existing = getWatchedEntry(req.userId, id);
  if (existing) return res.json({ entry: existing, completedChallenge: null });

  const completedChallenge = transaction(() => {
    run(
      `INSERT INTO watched (user_id, movie_id, watched_at, tier, watch_count)
       VALUES (?, ?, ?, ?, 1)`,
      [req.userId, id, Math.min(watchedAt ?? Date.now(), Date.now()), chosenTier],
    );
    run("DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?", [req.userId, id]);
    run(
      `UPDATE user_state SET picked_movie_id = NULL, pick_mood = NULL
       WHERE user_id = ? AND picked_movie_id = ?`,
      [req.userId, id],
    );
    logActivity(req.userId, "watched", { movieId: id });
    if (chosenTier) logActivity(req.userId, "tier", { movieId: id, tier: chosenTier });
    updateLevel(req.userId);
    return completeChallengeFor(req.userId, id);
  });

  res.status(201).json({ entry: getWatchedEntry(req.userId, id), completedChallenge });
});

const updateWatchedSchema = z
  .object({ tier: tier.nullable(), watchedAt: timestamp })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");

router.patch(
  "/watched/:movieId",
  validate(movieParam, "params"),
  validate(updateWatchedSchema),
  (req, res) => {
    const { movieId: id } = req.params;
    if (!getWatchedEntry(req.userId, id)) throw notFound("You haven't watched this movie");
    const { tier: newTier, watchedAt } = req.body;

    transaction(() => {
      if (newTier !== undefined) {
        // A tier replaces any legacy star rating as the one source of truth.
        run("UPDATE watched SET tier = ?, rating = NULL WHERE user_id = ? AND movie_id = ?", [
          newTier,
          req.userId,
          id,
        ]);
        if (newTier) logActivity(req.userId, "tier", { movieId: id, tier: newTier });
        else retractActivity(req.userId, "tier", id);
        // Rating (or un-rating) changes XP.
        updateLevel(req.userId);
      }
      if (watchedAt !== undefined) {
        run("UPDATE watched SET watched_at = ? WHERE user_id = ? AND movie_id = ?", [
          Math.min(watchedAt, Date.now()),
          req.userId,
          id,
        ]);
      }
    });
    res.json({ entry: getWatchedEntry(req.userId, id) });
  },
);

// A rewatch of something already watched: bumps the count and moves it to
// the top of "Recently Watched".
router.post("/watched/:movieId/rewatch", validate(movieParam, "params"), (req, res) => {
  const { changes } = run(
    `UPDATE watched SET watch_count = watch_count + 1, watched_at = ?
     WHERE user_id = ? AND movie_id = ?`,
    [Date.now(), req.userId, req.params.movieId],
  );
  if (!changes) throw notFound("You haven't watched this movie");
  res.json({ entry: getWatchedEntry(req.userId, req.params.movieId) });
});

router.delete("/watched/:movieId", validate(movieParam, "params"), (req, res) => {
  const { movieId: id } = req.params;
  transaction(() => {
    retractActivity(req.userId, "watched", id);
    retractActivity(req.userId, "tier", id);
    run("DELETE FROM watched WHERE user_id = ? AND movie_id = ?", [req.userId, id]);
    updateLevel(req.userId);
  });
  res.status(204).end();
});

router.delete("/watched", (req, res) => {
  transaction(() => {
    run("DELETE FROM watched WHERE user_id = ?", [req.userId]);
    updateLevel(req.userId);
  });
  res.status(204).end();
});

// ---- Tonight's pick (movieStore.pickedMovie / pickMood) ------------------

router.get("/pick", (req, res) => {
  res.json(toPick(getUserState(req.userId)));
});

// Only one pick at a time — setting a new one replaces it. `mood` is set
// when the pick came from a Home mood chip.
router.put(
  "/pick",
  validate(z.object({ movieId, mood: z.string().trim().min(1).max(40).nullable().optional() })),
  (req, res) => {
    assertMovie(req.body.movieId);
    run("UPDATE user_state SET picked_movie_id = ?, pick_mood = ? WHERE user_id = ?", [
      req.body.movieId,
      req.body.mood ?? null,
      req.userId,
    ]);
    res.json(toPick(getUserState(req.userId)));
  },
);

router.delete("/pick", (req, res) => {
  run("UPDATE user_state SET picked_movie_id = NULL, pick_mood = NULL WHERE user_id = ?", [
    req.userId,
  ]);
  res.status(204).end();
});

// ---- Manually unlocked collections (movieStore.unlockedCollections) ------

const setUnlocked = (userId, update) => {
  const current = fromJSON(getUserState(userId).unlocked_collections, []);
  const next = update(current);
  run("UPDATE user_state SET unlocked_collections = ? WHERE user_id = ?", [toJSON(next), userId]);
  return next;
};

const collectionParam = z.object({ collectionId });

router.put(
  "/unlocked-collections/:collectionId",
  validate(collectionParam, "params"),
  (req, res) => {
    const { collectionId: id } = req.params;
    const unlockedCollections = setUnlocked(req.userId, (ids) =>
      ids.includes(id) ? ids : [...ids, id],
    );
    res.json({ unlockedCollections });
  },
);

router.delete(
  "/unlocked-collections/:collectionId",
  validate(collectionParam, "params"),
  (req, res) => {
    const unlockedCollections = setUnlocked(req.userId, (ids) =>
      ids.filter((id) => id !== req.params.collectionId),
    );
    res.json({ unlockedCollections });
  },
);

// ---- Recommendations (services/recommendations.js) -----------------------

// A fresh set of picks for a Swipe/Spin session: watchlist movies get
// guaranteed slots, the rest follow the user's preferences, and watched
// movies are skipped.
router.get(
  "/recommendations",
  validate(
    z.object({
      count: z.coerce.number().int().min(1).max(50).default(10),
      includeWatchlist: z
        .enum(["true", "false"])
        .default("true")
        .transform((value) => value === "true"),
    }),
    "query",
  ),
  (req, res) => {
    const { count, includeWatchlist } = req.validQuery;
    const movies = generateRecommendations({
      preferences: fromJSON(getUserState(req.userId).preferences, {}),
      count,
      priorityIds: includeWatchlist ? listWatchlist(req.userId).map((e) => e.movieId) : [],
      skipIds: listWatched(req.userId).map((entry) => entry.movieId),
    });
    res.json({ movies });
  },
);

export default router;
