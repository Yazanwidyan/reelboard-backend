import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { fromJSON, get, run, toJSON, transaction } from "../db/index.js";
import { badRequest, conflict, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { getFullState, getUserState, toSettings } from "../lib/library.js";
import { ensureMovies, getMovieById } from "../lib/movies.js";
import {
  BIO_MAX,
  BOARD_NAME_MAX,
  boardId,
  challenge,
  collectionId,
  handle,
  leanings,
  MAX_PASSES,
  MAX_PINNED,
  MAX_RECENT_SEARCHES,
  movieId,
  preferences,
  tier,
  timestamp,
  S_TIER_ORDER_MAX,
  uniqueIds,
} from "../lib/schemas.js";
import { getUserRow, toProfile } from "../lib/users.js";
import { updateRanks } from "../lib/ranks.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/me.
const router = Router();

// GET /api/me — everything at once, to hydrate the app's stores on sign-in.
router.get("/", (req, res) => {
  res.json(getFullState(req.userId));
});

// ---- Profile (profileStore) ----------------------------------------------

router.get("/profile", (req, res) => {
  res.json({ profile: toProfile(getUserRow(req.userId)) });
});

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(50),
    bio: z.string().trim().max(BIO_MAX),
    // A URL, or the app's local file:// URI until avatar upload exists.
    avatarUri: z.string().trim().max(2000).nullable(),
    handle,
    // Ranks and level aren't accepted: the server works them out from the
    // watch history (lib/ranks.js). Older apps still send XP and a level;
    // they're dropped like any other unknown field.
  })
  .partial();

const PROFILE_COLUMNS = {
  displayName: "display_name",
  bio: "bio",
  avatarUri: "avatar_uri",
  handle: "handle",
};

router.patch("/profile", validate(profileSchema), (req, res) => {
  const updates = Object.entries(req.body).filter(([, value]) => value !== undefined);
  if (req.body.handle) {
    const owner = get("SELECT id FROM users WHERE handle = ?", [req.body.handle]);
    if (owner && owner.id !== req.userId) throw conflict(`@${req.body.handle} is taken`);
  }
  if (updates.length > 0) {
    const assignments = updates.map(([key]) => `${PROFILE_COLUMNS[key]} = :${key}`).join(", ");
    run(`UPDATE users SET ${assignments} WHERE id = :id`, {
      ...Object.fromEntries(updates),
      id: req.userId,
    });
  }
  res.json({ profile: toProfile(getUserRow(req.userId)) });
});

// The order of your S tier — your favourites, #1 first. (Kept as
// `top_ten`, its name from before the S tier was your top films.) Films
// tiered S that aren't in it come after, most recent first.
router.put(
  "/top-ten",
  validate(z.object({ movieIds: uniqueIds(movieId, S_TIER_ORDER_MAX) })),
  async (req, res) => {
    const movieIds = (await ensureMovies(req.body.movieIds)).map((movie) => movie.id);
    run("UPDATE users SET top_ten = ? WHERE id = ?", [toJSON(movieIds), req.userId]);
    res.json({ topTen: movieIds });
  },
);

// Completed collections pinned to the front of Profile, most recent first.
router.put(
  "/pinned-collections",
  validate(z.object({ collectionIds: uniqueIds(collectionId, MAX_PINNED) })),
  (req, res) => {
    run("UPDATE users SET pinned_collections = ? WHERE id = ?", [
      toJSON(req.body.collectionIds),
      req.userId,
    ]);
    res.json({ pinnedCollections: req.body.collectionIds });
  },
);

// ---- Settings (userStore, languageStore, themeStore, tipsStore) ----------

router.get("/settings", (req, res) => {
  res.json({ settings: toSettings(getUserState(req.userId)) });
});

const settingsSchema = z
  .object({
    language: z.enum(["en", "ar"]),
    theme: z.enum(["system", "light", "dark"]),
    // Merged into the current preferences, like setPreferences().
    preferences,
    hasCompletedOnboarding: z.boolean(),
    // Merged too: { tipId: true } marks a tip seen; {} with resetTips clears.
    tipsSeen: z.record(z.string().max(60), z.boolean()),
    resetTips: z.literal(true),
  })
  .partial();

router.patch("/settings", validate(settingsSchema), (req, res) => {
  const state = getUserState(req.userId);
  const current = toSettings(state);
  const body = req.body;
  const tipsSeen = { ...(body.resetTips ? {} : current.tipsSeen), ...body.tipsSeen };
  run(
    `UPDATE user_state SET language = ?, theme = ?, preferences = ?,
       has_completed_onboarding = ?, tips_seen = ? WHERE user_id = ?`,
    [
      body.language ?? current.language,
      body.theme ?? current.theme,
      toJSON({ ...current.preferences, ...body.preferences }),
      Number(body.hasCompletedOnboarding ?? current.hasCompletedOnboarding),
      toJSON(tipsSeen),
      req.userId,
    ],
  );
  res.json({ settings: toSettings(getUserState(req.userId)) });
});

// ---- Recent searches (recentSearchStore) ---------------------------------

const getSearches = (userId) => fromJSON(getUserState(userId).recent_searches, []);

router.get("/searches", (req, res) => {
  res.json({ recentSearches: getSearches(req.userId) });
});

router.post(
  "/searches",
  validate(z.object({ term: z.string().trim().min(1).max(100) })),
  (req, res) => {
    const { term } = req.body;
    const recentSearches = [
      term,
      ...getSearches(req.userId).filter((entry) => entry.toLowerCase() !== term.toLowerCase()),
    ].slice(0, MAX_RECENT_SEARCHES);
    run("UPDATE user_state SET recent_searches = ? WHERE user_id = ?", [
      toJSON(recentSearches),
      req.userId,
    ]);
    res.status(201).json({ recentSearches });
  },
);

router.delete("/searches", (req, res) => {
  run("UPDATE user_state SET recent_searches = '[]' WHERE user_id = ?", [req.userId]);
  res.status(204).end();
});

// ---- Account -------------------------------------------------------------

// Deletes the account and everything in it. Asks for the password again —
// or, for an account made with Google / Apple (no password), the word DELETE.
router.delete(
  "/",
  validate(z.object({ password: z.string().min(1).optional(), confirm: z.string().optional() })),
  async (req, res) => {
    const { password_hash: hash, has_password: hasPassword } = getUserRow(req.userId);
    if (hasPassword) {
      if (!req.body.password || !(await bcrypt.compare(req.body.password, hash))) {
        throw unauthorized("Wrong password");
      }
    } else if (req.body.confirm !== "DELETE") {
      throw badRequest("Type DELETE to confirm");
    }
    run("DELETE FROM users WHERE id = ?", [req.userId]);
    res.status(204).end();
  },
);

// ---- Import from the app's local storage ---------------------------------
//
// POST /api/me/import — upload what the app has in AsyncStorage (the
// `state` of each persisted Zustand store) the first time someone signs in,
// so nothing logged offline is lost. Each store present REPLACES that part
// of the account; stores left out are untouched. Unknown movie ids are
// skipped rather than failing the whole import.

const looseArray = (schema, max) => z.array(z.unknown()).max(max).transform((items) =>
  items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

const importSchema = z.object({
  movieStore: z
    .object({
      bucketList: looseArray(z.object({ movieId, addedAt: timestamp }), 1000).optional(),
      watched: looseArray(
        z.object({
          movieId,
          timestamp,
          tier: tier.nullable().optional(),
          rating: z.number().min(0).max(5).nullable().optional(),
          watchCount: z.number().int().min(1).optional(),
        }),
        5000,
      ).optional(),
      pickedMovie: movieId.nullable().optional(),
      pickMood: z.object({ movieId, mood: z.string().max(40) }).nullable().optional(),
      unlockedCollections: z.array(collectionId).max(500).optional(),
    })
    .optional(),
  boardStore: z
    .object({
      boards: looseArray(
        z.object({
          id: boardId.optional(),
          name: z.string().trim().min(1),
          movieIds: z.array(movieId).max(1000),
          createdAt: timestamp.optional(),
          updatedAt: timestamp.optional(),
        }),
        200,
      ),
    })
    .optional(),
  profileStore: z
    .object({
      displayName: z.string().trim().min(1).max(50).optional(),
      bio: z.string().optional(),
      topTen: z.array(movieId).max(S_TIER_ORDER_MAX).optional(),
      pinnedCollections: z.array(collectionId).max(MAX_PINNED).optional(),
    })
    .optional(),
  userStore: z
    .object({ preferences: preferences.optional(), hasCompletedOnboarding: z.boolean().optional() })
    .optional(),
  tasteStore: z
    .object({
      aspects: z.record(z.string(), z.array(z.string().max(40)).max(20)).optional(),
      passes: looseArray(z.object({ movieId, at: timestamp }), MAX_PASSES).optional(),
      leanings: leanings.optional(),
    })
    .optional(),
  challengeStore: z
    .object({
      activeChallenge: challenge.nullable().optional(),
      history: looseArray(
        challenge.extend({
          status: z.enum(["completed", "skipped"]),
          resolvedAt: timestamp,
        }),
        1000,
      ).optional(),
    })
    .optional(),
  languageStore: z.object({ language: z.enum(["en", "ar"]) }).optional(),
  themeStore: z.object({ mode: z.enum(["system", "light", "dark"]) }).optional(),
  tipsStore: z.object({ seen: z.record(z.string(), z.boolean()) }).optional(),
  recentSearchStore: z
    .object({ recentSearches: z.array(z.string().trim().min(1).max(100)) })
    .optional(),
});

const known = (id) => Boolean(getMovieById(id));
const dedupeBy = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];

router.post("/import", validate(importSchema), (req, res) => {
  const me = req.userId;
  const body = req.body;
  const setState = (column, value) =>
    run(`UPDATE user_state SET ${column} = ? WHERE user_id = ?`, [value, me]);

  transaction(() => {
    const movies = body.movieStore;
    if (movies?.bucketList) {
      run("DELETE FROM watchlist WHERE user_id = ?", [me]);
      for (const entry of dedupeBy(movies.bucketList.filter((e) => known(e.movieId)), (e) => e.movieId)) {
        run("INSERT INTO watchlist (user_id, movie_id, added_at) VALUES (?, ?, ?)", [
          me,
          entry.movieId,
          entry.addedAt,
        ]);
      }
    }
    if (movies?.watched) {
      run("DELETE FROM watched WHERE user_id = ?", [me]);
      for (const entry of dedupeBy(movies.watched.filter((e) => known(e.movieId)), (e) => e.movieId)) {
        run(
          `INSERT INTO watched (user_id, movie_id, watched_at, tier, rating, watch_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            me,
            entry.movieId,
            Math.min(entry.timestamp, Date.now()),
            entry.tier ?? null,
            entry.tier ? null : (entry.rating ?? null),
            entry.watchCount ?? 1,
          ],
        );
      }
      updateRanks(me);
    }
    if (movies && "pickedMovie" in movies) {
      const picked = movies.pickedMovie && known(movies.pickedMovie) ? movies.pickedMovie : null;
      setState("picked_movie_id", picked);
      setState("pick_mood", picked && movies.pickMood?.movieId === picked ? movies.pickMood.mood : null);
    }
    if (movies?.unlockedCollections) {
      setState("unlocked_collections", toJSON([...new Set(movies.unlockedCollections)]));
    }

    if (body.boardStore) {
      run("DELETE FROM boards WHERE user_id = ?", [me]);
      for (const board of body.boardStore.boards) {
        // Keep the app's own id unless some other account already has it.
        const id =
          board.id && !get("SELECT 1 FROM boards WHERE id = ?", [board.id]) ? board.id : newId("b");
        const createdAt = board.createdAt ?? Date.now();
        run(
          "INSERT INTO boards (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          [id, me, board.name.slice(0, BOARD_NAME_MAX), createdAt, board.updatedAt ?? createdAt],
        );
        [...new Set(board.movieIds)].filter(known).forEach((movie, position) => {
          run("INSERT INTO board_movies (board_id, movie_id, position) VALUES (?, ?, ?)", [
            id,
            movie,
            position,
          ]);
        });
      }
    }

    const profile = body.profileStore;
    if (profile) {
      // "You" is the app's placeholder name — don't overwrite a real one with it.
      if (profile.displayName && profile.displayName !== "You") {
        run("UPDATE users SET display_name = ? WHERE id = ?", [profile.displayName, me]);
      }
      if (profile.bio !== undefined) {
        run("UPDATE users SET bio = ? WHERE id = ?", [profile.bio.slice(0, BIO_MAX), me]);
      }
      if (profile.topTen) {
        run("UPDATE users SET top_ten = ? WHERE id = ?", [
          toJSON([...new Set(profile.topTen)].filter(known)),
          me,
        ]);
      }
      if (profile.pinnedCollections) {
        run("UPDATE users SET pinned_collections = ? WHERE id = ?", [
          toJSON(profile.pinnedCollections),
          me,
        ]);
      }
    }

    if (body.userStore?.preferences) {
      const current = fromJSON(getUserState(me).preferences, {});
      setState("preferences", toJSON({ ...current, ...body.userStore.preferences }));
    }
    if (body.userStore?.hasCompletedOnboarding !== undefined) {
      setState("has_completed_onboarding", Number(body.userStore.hasCompletedOnboarding));
    }

    const taste = body.tasteStore;
    if (taste?.aspects) {
      run("DELETE FROM taste_aspects WHERE user_id = ?", [me]);
      for (const [movie, keys] of Object.entries(taste.aspects)) {
        if (known(movie) && keys.length > 0) {
          run("INSERT INTO taste_aspects (user_id, movie_id, aspects) VALUES (?, ?, ?)", [
            me,
            movie,
            toJSON(keys),
          ]);
        }
      }
    }
    if (taste?.passes) {
      run("DELETE FROM taste_passes WHERE user_id = ?", [me]);
      for (const pass of dedupeBy(taste.passes.filter((p) => known(p.movieId)), (p) => p.movieId)) {
        run("INSERT INTO taste_passes (user_id, movie_id, at) VALUES (?, ?, ?)", [
          me,
          pass.movieId,
          pass.at,
        ]);
      }
    }
    if (taste && "leanings" in taste) setState("leanings", toJSON(taste.leanings ?? null));

    const challenges = body.challengeStore;
    if (challenges) {
      run("DELETE FROM challenges WHERE user_id = ?", [me]);
      const insert = (item, status, resolvedAt) => {
        const { status: _s, resolvedAt: _r, ...data } = item;
        run(
          `INSERT OR IGNORE INTO challenges
             (id, user_id, status, target_movie_id, data, accepted_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [newId("c"), me, status, item.targetMovieId, toJSON(data), resolvedAt ?? Date.now(), resolvedAt],
        );
      };
      for (const item of challenges.history ?? []) insert(item, item.status, item.resolvedAt);
      if (challenges.activeChallenge) insert(challenges.activeChallenge, "active", null);
    }

    if (body.languageStore) setState("language", body.languageStore.language);
    if (body.themeStore) setState("theme", body.themeStore.mode);
    if (body.tipsStore) setState("tips_seen", toJSON(body.tipsStore.seen));
    if (body.recentSearchStore) {
      setState(
        "recent_searches",
        toJSON(body.recentSearchStore.recentSearches.slice(0, MAX_RECENT_SEARCHES)),
      );
    }
  });

  res.json(getFullState(me));
});

export default router;
