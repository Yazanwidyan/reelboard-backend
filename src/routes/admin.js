import { Router } from "express";
import { z } from "zod";
import { all, catalogMeta, fromJSON, get, readSagas, run, toJSON, transaction, writeSagas } from "../db/index.js";
import { listActivity } from "../lib/activity.js";
import { getSagas, resetCollections, SAGA } from "../lib/collections.js";
import { readCuration, updateCuration } from "../lib/curation.js";
import { badRequest, notFound } from "../lib/errors.js";
import { ensureMovie, ensureMovies, getMovieById, resetMovieCache } from "../lib/movies.js";
import { movieId, TIERS } from "../lib/schemas.js";
import { getUserRow, toProfile } from "../lib/users.js";
import { resetXPCatalog, updateAllLevels } from "../lib/xp.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/admin, behind requireAuth + requireAdmin — the admin site
// (../Reelboard-admin). Edits to movies and sagas change the live database
// AND data/curation.json, so `npm run build-pool` keeps them.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
const page = z.coerce.number().int().min(1).default(1);
const limit = (max, fallback) => z.coerce.number().int().min(1).max(max).default(fallback);
const like = (q) => `%${q.replace(/[%_\\]/g, "\\$&")}%`;
// Only the named parameters a statement uses (SQLite won't take others).
const used = (sql, params) =>
  Object.fromEntries(Object.entries(params).filter(([key]) => sql.includes(`:${key}`)));
const allNamed = (sql, params) => all(sql, used(sql, params));
const countNamed = (sql, params) => get(sql, used(sql, params)).n;

// After an edit to the pool or the sagas: everything that read them is read
// again, and every level recomputed (XP counts saga ranks).
const refresh = () => {
  resetMovieCache();
  resetCollections();
  resetXPCatalog();
  updateAllLevels();
};

router.get("/me", (req, res) => {
  res.json({ admin: true, user: toProfile(getUserRow(req.userId)) });
});

// ---- Dashboard ---------------------------------------------------------------

const count = (sql, params = []) => get(sql, params).n;

router.get("/stats", (req, res) => {
  const now = Date.now();
  const since = (days) => now - days * DAY;
  const activeSince = (days) =>
    count("SELECT COUNT(DISTINCT user_id) AS n FROM activity WHERE created_at > ?", [since(days)]);

  // Sign-ups per day for the last 30 days, oldest first, zeros included.
  const perDay = new Map(
    all("SELECT CAST(created_at / ? AS INTEGER) AS day, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY day", [
      DAY,
      since(30),
    ]).map((row) => [row.day, row.n]),
  );
  const today = Math.floor(now / DAY);
  const signups = Array.from({ length: 30 }, (_, i) => {
    const day = today - 29 + i;
    return { date: new Date(day * DAY).toISOString().slice(0, 10), count: perDay.get(day) ?? 0 };
  });

  const movieRows = (rows) =>
    rows.map((row) => {
      const movie = getMovieById(row.movie_id);
      return { id: row.movie_id, title: movie?.title ?? row.movie_id, year: movie?.year ?? null, poster: movie?.poster ?? null, count: row.n };
    });

  // How many people started and finished each saga.
  const sagas = getSagas().map((saga) => {
    const placeholders = saga.movieIds.map(() => "?").join(",");
    const progress = all(
      `SELECT user_id, COUNT(*) AS n FROM watched WHERE movie_id IN (${placeholders}) GROUP BY user_id`,
      saga.movieIds,
    );
    return {
      id: saga.id,
      title: saga.title,
      kind: saga.kind,
      films: saga.movieIds.length,
      started: progress.length,
      finished: progress.filter((row) => row.n >= saga.movieIds.length).length,
    };
  });

  res.json({
    users: {
      total: count("SELECT COUNT(*) AS n FROM users"),
      new7: count("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", [since(7)]),
      new30: count("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", [since(30)]),
      active1: activeSince(1),
      active7: activeSince(7),
      active30: activeSince(30),
    },
    signups,
    totals: {
      watched: count("SELECT COUNT(*) AS n FROM watched"),
      tiered: count("SELECT COUNT(*) AS n FROM watched WHERE tier IS NOT NULL"),
      watchlist: count("SELECT COUNT(*) AS n FROM watchlist"),
      boards: count("SELECT COUNT(*) AS n FROM boards"),
      clubs: count("SELECT COUNT(*) AS n FROM clubs"),
      friendships: count("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted'"),
      poolMovies: count("SELECT COUNT(*) AS n FROM movies WHERE in_pool = 1"),
      otherMovies: count("SELECT COUNT(*) AS n FROM movies WHERE in_pool = 0"),
      handTuned: count("SELECT COUNT(*) AS n FROM movies WHERE in_pool = 1 AND vibe_source = 'hand'"),
    },
    // Logged in the last 30 days (the activity feed keeps 90).
    topWatched: movieRows(
      all(
        `SELECT movie_id, COUNT(*) AS n FROM activity WHERE type = 'watched' AND created_at > ?
         GROUP BY movie_id ORDER BY n DESC LIMIT 10`,
        [since(30)],
      ),
    ),
    topS: movieRows(
      all("SELECT movie_id, COUNT(*) AS n FROM watched WHERE tier = 'S' GROUP BY movie_id ORDER BY n DESC LIMIT 10"),
    ),
    sagas: sagas.sort((a, b) => b.started - a.started),
  });
});

// ---- Users -------------------------------------------------------------------

router.get(
  "/users",
  validate(z.object({ q: z.string().trim().max(100).default(""), page, limit: limit(100, 25) }), "query"),
  (req, res) => {
    const { q, page: pageNumber, limit: size } = req.validQuery;
    const where = q ? "WHERE email LIKE :q ESCAPE '\\' OR handle LIKE :q ESCAPE '\\' OR display_name LIKE :q ESCAPE '\\'" : "";
    const params = { q: like(q) };
    const users = allNamed(
      `SELECT users.*,
              (SELECT COUNT(*) FROM watched WHERE watched.user_id = users.id) AS watched_count,
              (SELECT MAX(created_at) FROM activity WHERE activity.user_id = users.id) AS last_active
       FROM users ${where} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit: size, offset: (pageNumber - 1) * size },
    ).map((row) => ({
      id: row.id,
      name: row.display_name,
      handle: `@${row.handle}`,
      email: row.email,
      level: row.level,
      xp: row.xp,
      color: row.color,
      avatarUri: row.avatar_uri,
      createdAt: row.created_at,
      watchedCount: row.watched_count,
      lastActive: row.last_active,
    }));
    const total = countNamed(`SELECT COUNT(*) AS n FROM users ${where}`, params);
    res.json({ users, page: pageNumber, total, totalPages: Math.ceil(total / size) });
  },
);

const userParam = validate(z.object({ id: z.string().min(1).max(64) }), "params");

router.get("/users/:id", userParam, (req, res) => {
  const row = getUserRow(req.params.id);
  if (!row) throw notFound("No such user");
  const id = row.id;
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, 0]));
  all("SELECT tier, COUNT(*) AS n FROM watched WHERE user_id = ? AND tier IS NOT NULL GROUP BY tier", [id]).forEach(
    (entry) => {
      tiers[entry.tier] = entry.n;
    },
  );
  res.json({
    user: toProfile(row),
    counts: {
      watched: count("SELECT COUNT(*) AS n FROM watched WHERE user_id = ?", [id]),
      watchlist: count("SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", [id]),
      boards: count("SELECT COUNT(*) AS n FROM boards WHERE user_id = ?", [id]),
      clubs: count("SELECT COUNT(*) AS n FROM club_members WHERE user_id = ?", [id]),
      friends: count(
        "SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester_id = :id OR addressee_id = :id)",
        { id },
      ),
    },
    tiers,
    activity: listActivity([id], { limit: 20 }),
  });
});

// Deletes the account and everything in it. Not your own (sign in to the app
// for that).
router.delete("/users/:id", userParam, (req, res) => {
  if (req.params.id === req.userId) throw badRequest("You can't delete your own account here");
  if (!getUserRow(req.params.id)) throw notFound("No such user");
  run("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.status(204).end();
});

// ---- Movies & vibes -------------------------------------------------------------

router.get("/meta", (req, res) => {
  res.json({
    dimensions: catalogMeta.dimensions,
    themes: catalogMeta.themes,
    tiers: TIERS,
    sagaKinds: ["franchise", "studio", "theme", "director", "actor"],
  });
});

const toListedMovie = (row) => ({
  id: row.id,
  title: row.title,
  year: row.year,
  rating: row.rating,
  poster: row.poster,
  franchise: row.franchise,
  inPool: row.in_pool === 1,
  rank: row.rank,
  vibeSource: row.vibe_source,
  votes: fromJSON(row.details, {})?.votes ?? 0,
  watchedCount: row.watched_count,
});

router.get(
  "/movies",
  validate(
    z.object({
      q: z.string().trim().max(100).default(""),
      scope: z.enum(["pool", "other", "all"]).default("pool"),
      vibe: z.enum(["any", "hand", "estimated"]).default("any"),
      page,
      limit: limit(100, 30),
    }),
    "query",
  ),
  (req, res) => {
    const { q, scope, vibe, page: pageNumber, limit: size } = req.validQuery;
    const filters = [
      q && "(title LIKE :q ESCAPE '\\' OR director LIKE :q ESCAPE '\\' OR franchise LIKE :q ESCAPE '\\' OR id = :exact)",
      scope === "pool" && "in_pool = 1",
      scope === "other" && "in_pool = 0",
      vibe !== "any" && "vibe_source = :vibe",
    ].filter(Boolean);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const params = { q: like(q), exact: q, vibe };
    const movies = allNamed(
      `SELECT movies.*, (SELECT COUNT(*) FROM watched WHERE watched.movie_id = movies.id) AS watched_count
       FROM movies ${where}
       ORDER BY in_pool DESC, rank IS NULL, rank, title LIMIT :limit OFFSET :offset`,
      { ...params, limit: size, offset: (pageNumber - 1) * size },
    ).map(toListedMovie);
    const total = countNamed(`SELECT COUNT(*) AS n FROM movies ${where}`, params);
    res.json({ movies, page: pageNumber, total, totalPages: Math.ceil(total / size) });
  },
);

const movieParam = validate(z.object({ id: movieId }), "params");

const movieStats = (id) => {
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, 0]));
  all("SELECT tier, COUNT(*) AS n FROM watched WHERE movie_id = ? AND tier IS NOT NULL GROUP BY tier", [id]).forEach(
    (row) => {
      tiers[row.tier] = row.n;
    },
  );
  return {
    watched: count("SELECT COUNT(*) AS n FROM watched WHERE movie_id = ?", [id]),
    watchlist: count("SELECT COUNT(*) AS n FROM watchlist WHERE movie_id = ?", [id]),
    tiers,
    sagas: getSagas()
      .filter((saga) => saga.movieIds.includes(id))
      .map((saga) => ({ id: saga.id, title: saga.title })),
  };
};

// Any TMDB movie — one not on the server yet is fetched.
router.get("/movies/:id", movieParam, async (req, res) => {
  const { fetchedAt, ...movie } = await ensureMovie(req.params.id);
  const curation = readCuration();
  res.json({
    movie,
    stats: movieStats(movie.id),
    curated: curation.movies.some((entry) => entry.id === movie.id),
    excluded: (curation.excluded ?? []).includes(movie.id),
  });
});

const vibe = z.object({
  dims: z.array(z.number().int().min(1).max(5)).length(6),
  themes: z.array(z.string().min(1).max(40)).max(3),
});

// Hand-tune a movie's vibe, set its franchise, or put it in / take it out of
// the pool.
router.patch(
  "/movies/:id",
  movieParam,
  validate(
    z
      .object({ vibe, franchise: z.string().trim().max(80).nullable(), inPool: z.boolean() })
      .partial()
      .refine((body) => Object.keys(body).length > 0, "Nothing to change"),
  ),
  async (req, res) => {
    const movie = await ensureMovie(req.params.id);
    const { vibe: newVibe, franchise, inPool } = req.body;
    if (newVibe) {
      const unknown = newVibe.themes.filter((theme) => !(theme in catalogMeta.themes));
      if (unknown.length > 0) throw badRequest(`Unknown themes: ${unknown.join(", ")}`);
    }
    const id = movie.id;

    updateCuration((curation) => {
      curation.excluded ??= [];
      let entry = curation.movies.find((item) => item.id === id);
      const curate = () => {
        if (!entry) {
          entry = { id, title: movie.title };
          curation.movies.push(entry);
        }
        curation.excluded = curation.excluded.filter((item) => item !== id);
        return entry;
      };
      if (newVibe) curate().vibe = newVibe;
      if (franchise !== undefined) {
        if (franchise) curate().franchise = franchise;
        else if (entry) delete entry.franchise;
      }
      if (inPool === true) curate();
      if (inPool === false) {
        curation.movies = curation.movies.filter((item) => item.id !== id);
        if (!curation.excluded.includes(id)) curation.excluded.push(id);
      }
      if (curation.excluded.length === 0) delete curation.excluded;
    });

    transaction(() => {
      if (newVibe) run("UPDATE movies SET vibe = ?, vibe_source = 'hand' WHERE id = ?", [toJSON(newVibe), id]);
      if (franchise !== undefined) run("UPDATE movies SET franchise = ? WHERE id = ?", [franchise || null, id]);
      if (inPool === true && !movie.inPool) {
        const next = (get("SELECT MAX(rank) AS n FROM movies WHERE in_pool = 1").n ?? 0) + 1;
        run("UPDATE movies SET in_pool = 1, rank = ? WHERE id = ?", [next, id]);
      }
      if (inPool === false) run("UPDATE movies SET in_pool = 0, rank = NULL WHERE id = ?", [id]);
    });
    refresh();
    const { fetchedAt, ...updated } = getMovieById(id);
    res.json({ movie: updated, stats: movieStats(id) });
  },
);

// ---- Sagas ---------------------------------------------------------------------

const sagaStats = (saga) => {
  if (saga.movieIds.length === 0) return { started: 0, finished: 0 };
  const progress = all(
    `SELECT user_id, COUNT(*) AS n FROM watched WHERE movie_id IN (${saga.movieIds.map(() => "?").join(",")})
     GROUP BY user_id`,
    saga.movieIds,
  );
  return { started: progress.length, finished: progress.filter((row) => row.n >= saga.movieIds.length).length };
};

const sagaCard = (movieIds) =>
  movieIds
    .map(getMovieById)
    .filter(Boolean)
    .map((movie) => ({ id: movie.id, title: movie.title, year: movie.year, poster: movie.poster, inPool: movie.inPool }));

router.get("/sagas", (req, res) => {
  res.json({
    sagas: readSagas().map((saga) => ({ ...saga, ...sagaStats(saga), cover: sagaCard(saga.movieIds.slice(0, 4)) })),
  });
});

const sagaParam = validate(z.object({ id: z.string().regex(/^saga-[a-z0-9-]{1,60}$/) }), "params");

router.get("/sagas/:id", sagaParam, (req, res) => {
  const saga = readSagas().find((item) => item.id === req.params.id);
  if (!saga) throw notFound("No such saga");
  const source = readCuration().sagas?.find((item) => `saga-${item.id}` === saga.id)?.from ?? null;
  res.json({ saga, stats: sagaStats(saga), movies: sagaCard(saga.movieIds), from: source });
});

const rank = z.object({ title: z.string().trim().min(1).max(40), at: z.number().int().min(1) });
const sagaFields = {
  title: z.string().trim().min(1).max(60),
  subtitle: z.string().trim().max(120),
  kind: z.enum(["franchise", "studio", "theme", "director", "actor"]),
  movieIds: z
    .array(movieId)
    .min(3)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Films must be unique"),
  ranks: z.array(rank).min(1).max(5),
};

// Ranks rising, the last one at every film.
const checkRanks = (ranks, total) => {
  const sorted = [...ranks].sort((a, b) => a.at - b.at);
  sorted.forEach((item, i) => {
    if (item.at > total) throw badRequest(`"${item.title}" needs ${item.at} films — the saga has ${total}`);
    if (i > 0 && item.at === sorted[i - 1].at) throw badRequest("Two ranks can't need the same number of films");
  });
  sorted[sorted.length - 1] = { ...sorted[sorted.length - 1], at: total };
  return sorted;
};

// The films, all of them in the pool (added if they weren't).
const poolFilms = async (movieIds) => {
  const movies = await ensureMovies(movieIds, { strict: true });
  const outside = movies.filter((movie) => !movie.inPool);
  if (outside.length > 0) {
    updateCuration((curation) => {
      outside.forEach((movie) => {
        if (!curation.movies.some((item) => item.id === movie.id)) curation.movies.push({ id: movie.id, title: movie.title });
      });
      if (curation.excluded) {
        curation.excluded = curation.excluded.filter((id) => !outside.some((movie) => movie.id === id));
        if (curation.excluded.length === 0) delete curation.excluded;
      }
    });
    transaction(() => {
      let next = (get("SELECT MAX(rank) AS n FROM movies WHERE in_pool = 1").n ?? 0) + 1;
      outside.forEach((movie) => {
        run("UPDATE movies SET in_pool = 1, rank = ? WHERE id = ?", [next, movie.id]);
        next += 1;
      });
    });
  }
  return movies;
};

// The best-known film's backdrop, for a saga without its own artwork.
const fallbackArt = (movies) => {
  const backdrop = [...movies]
    .filter((movie) => movie.backdrop)
    .sort((a, b) => (b.details?.votes ?? 0) - (a.details?.votes ?? 0))[0]?.backdrop;
  return backdrop ? { backdrop } : null;
};

// The curation's version of a saga: ranks as counts, the top one "all";
// the films as picked ids, or its old `from` if they didn't change. An
// actor's or a director's saga with picked films keeps who it's about.
const toCurated = (saga, from) => ({
  id: saga.id.replace(/^saga-/, ""),
  title: saga.title,
  subtitle: saga.subtitle,
  kind: saga.kind,
  from,
  ...(saga.person && from.ids ? { person: saga.person } : {}),
  ranks: saga.ranks.map((item, i, list) => ({ title: item.title, at: i === list.length - 1 ? "all" : item.at })),
});

const saveSagas = (sagas) => {
  writeSagas(sagas);
  refresh();
};

router.post(
  "/sagas",
  validate(z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/), ...sagaFields, subtitle: sagaFields.subtitle.default("") })),
  async (req, res) => {
    const { id, title, subtitle, kind, movieIds, ranks } = req.body;
    const sagas = readSagas();
    if (sagas.some((saga) => saga.id === `saga-${id}`)) throw badRequest("A saga with that id exists");
    const movies = await poolFilms(movieIds);
    const saga = {
      id: `saga-${id}`,
      type: SAGA,
      kind,
      title,
      subtitle,
      movieIds,
      ranks: checkRanks(ranks, movieIds.length),
      art: fallbackArt(movies),
    };
    updateCuration((curation) => {
      curation.sagas = [...(curation.sagas ?? []), toCurated(saga, { ids: movieIds })];
    });
    saveSagas([...sagas, saga]);
    res.status(201).json({ saga, stats: sagaStats(saga), movies: sagaCard(saga.movieIds) });
  },
);

router.patch(
  "/sagas/:id",
  sagaParam,
  validate(
    z
      .object(sagaFields)
      .partial()
      .refine((body) => Object.keys(body).length > 0, "Nothing to change"),
  ),
  async (req, res) => {
    const sagas = readSagas();
    const index = sagas.findIndex((saga) => saga.id === req.params.id);
    if (index === -1) throw notFound("No such saga");
    const current = sagas[index];
    const changes = req.body;
    const movieIds = changes.movieIds ?? current.movieIds;
    if (changes.movieIds) await poolFilms(changes.movieIds);
    const filmsChanged = movieIds.join() !== current.movieIds.join();
    // Who it's about (sagas built before build-pool stored it: from the
    // curation), kept when its films become a picked list.
    const curated = readCuration().sagas?.find((item) => `saga-${item.id}` === current.id);
    const person = current.person ?? curated?.from?.actor ?? curated?.from?.director ?? curated?.person;
    const saga = {
      ...current,
      ...(person ? { person } : {}),
      ...changes,
      movieIds,
      ranks: checkRanks(
        changes.ranks ?? (filmsChanged ? current.ranks.filter((item) => item.at <= movieIds.length) : current.ranks),
        movieIds.length,
      ),
    };
    updateCuration((curation) => {
      const list = curation.sagas ?? [];
      const at = list.findIndex((item) => `saga-${item.id}` === saga.id);
      const from = filmsChanged || at === -1 ? { ids: movieIds } : list[at].from;
      if (at === -1) list.push(toCurated(saga, from));
      else list[at] = toCurated(saga, from);
      curation.sagas = list;
    });
    sagas[index] = saga;
    saveSagas(sagas);
    res.json({ saga, stats: sagaStats(saga), movies: sagaCard(saga.movieIds) });
  },
);

router.delete("/sagas/:id", sagaParam, (req, res) => {
  const sagas = readSagas();
  if (!sagas.some((saga) => saga.id === req.params.id)) return res.status(204).end();
  updateCuration((curation) => {
    curation.sagas = (curation.sagas ?? []).filter((item) => `saga-${item.id}` !== req.params.id);
  });
  saveSagas(sagas.filter((saga) => saga.id !== req.params.id));
  res.status(204).end();
});

// ---- Clubs ---------------------------------------------------------------------

router.get(
  "/clubs",
  validate(z.object({ q: z.string().trim().max(100).default("") }), "query"),
  (req, res) => {
    const { q } = req.validQuery;
    const clubs = allNamed(
      `SELECT clubs.*, users.display_name AS owner_name, users.handle AS owner_handle,
              (SELECT COUNT(*) FROM club_members WHERE club_members.club_id = clubs.id) AS member_count,
              (SELECT COUNT(*) FROM club_movies WHERE club_movies.club_id = clubs.id) AS movie_count
       FROM clubs JOIN users ON users.id = clubs.owner_id
       ${q ? "WHERE clubs.name LIKE :q ESCAPE '\\' OR users.handle LIKE :q ESCAPE '\\'" : ""}
       ORDER BY clubs.created_at DESC LIMIT 200`,
      { q: like(q) },
    ).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      owner: { id: row.owner_id, name: row.owner_name, handle: `@${row.owner_handle}` },
      memberCount: row.member_count,
      movieCount: row.movie_count,
      nowWatching: row.now_watching_movie_id ? getMovieById(row.now_watching_movie_id)?.title ?? null : null,
      createdAt: row.created_at,
    }));
    res.json({ clubs });
  },
);

router.delete("/clubs/:id", validate(z.object({ id: z.string().min(1).max(64) }), "params"), (req, res) => {
  run("DELETE FROM clubs WHERE id = ?", [req.params.id]);
  res.status(204).end();
});

export default router;
