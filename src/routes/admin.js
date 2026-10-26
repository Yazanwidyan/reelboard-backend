import { Router } from "express";
import { z } from "zod";
import { all, catalogMeta, fromJSON, get, readSagas, run, toJSON, transaction, writeSagas } from "../db/index.js";
import { listActivity } from "../lib/activity.js";
import { listAdminLog, logAdmin } from "../lib/adminLog.js";
import { getSagas, resetCollections, SAGA } from "../lib/collections.js";
import { readCuration, updateCuration } from "../lib/curation.js";
import { badRequest, notFound } from "../lib/errors.js";
import { ensureMovie, ensureMovies, getMovieById, resetMovieCache } from "../lib/movies.js";
import { movieId, TIERS } from "../lib/schemas.js";
import { listBoards, toBoard } from "../lib/library.js";
import { createSagaResolver, resolveRanks } from "../lib/sagaSources.js";
import { titleName } from "../lib/titles.js";
import { IMAGE_BASE, tmdbGet } from "../lib/tmdb.js";
import { getUserRow, isSuspended, toProfile } from "../lib/users.js";
import { isAdmin } from "../middleware/admin.js";
import { validate } from "../middleware/validate.js";
import { CLUB_DESCRIPTION_MAX, CLUB_NAME_MAX } from "./clubs.js";

// Mounted at /api/admin, behind requireAuth + requireAdmin — the admin site
// (../Reelboard-admin). Edits to movies and sagas change the live database
// AND data/curation.json, so `npm run build-pool` keeps them.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
// Every change made here goes in the admin log (lib/adminLog).
const log = (req, action, target, summary) => logAdmin(req.userId, action, target, summary);
const quoted = (text) => `"${text}"`;
const page = z.coerce.number().int().min(1).default(1);
const limit = (max, fallback) => z.coerce.number().int().min(1).max(max).default(fallback);
const like = (q) => `%${q.replace(/[%_\\]/g, "\\$&")}%`;
// Only the named parameters a statement uses (SQLite won't take others).
const used = (sql, params) =>
  Object.fromEntries(Object.entries(params).filter(([key]) => sql.includes(`:${key}`)));
const allNamed = (sql, params) => all(sql, used(sql, params));
const countNamed = (sql, params) => get(sql, used(sql, params)).n;

// After an edit to the pool or the sagas: everything that read them is read
// again. (Sagas aren't ranks, so nobody's ranks change.)
const refresh = () => {
  resetMovieCache();
  resetCollections();
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
  validate(
    z.object({
      q: z.string().trim().max(100).default(""),
      status: z.enum(["all", "suspended"]).default("all"),
      page,
      limit: limit(100, 25),
    }),
    "query",
  ),
  (req, res) => {
    const { q, status, page: pageNumber, limit: size } = req.validQuery;
    const conditions = [
      q && "(email LIKE :q ESCAPE '\\' OR handle LIKE :q ESCAPE '\\' OR display_name LIKE :q ESCAPE '\\')",
      status === "suspended" && "suspended_at IS NOT NULL",
    ].filter(Boolean);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
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
      ranks: row.ranks,
      title: titleName(row.level),
      color: row.color,
      avatarUri: row.avatar_uri,
      createdAt: row.created_at,
      watchedCount: row.watched_count,
      lastActive: row.last_active,
      suspendedAt: row.suspended_at ?? null,
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
    suspension: isSuspended(row) ? { at: row.suspended_at, reason: row.suspended_reason ?? "" } : null,
    isAdmin: isAdmin(id),
    lists: listBoards(id).map((board) => ({
      id: board.id,
      name: board.name,
      movieCount: board.movieIds.length,
      posters: board.movieIds.slice(0, 4).map((movie) => getMovieById(movie)?.poster ?? null),
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    })),
  });
});

// ---- Moderation ----------------------------------------------------------------
//
// Suspending keeps the account and everything in it, but it can't sign in
// or use the app (its sessions stop working at once), and nobody else sees
// it — search, profiles, friends and their feeds. Unsuspending brings it all
// back. Not your own account, nor another admin's.

const moderatable = (id, req) => {
  const row = getUserRow(id);
  if (!row) throw notFound("No such user");
  if (id === req.userId) throw badRequest("You can't do that to your own account");
  if (isAdmin(id)) throw badRequest("That's an admin account — take it off ADMIN_EMAILS first");
  return row;
};

const suspendUser = (req, id, reason) => {
  const row = moderatable(id, req);
  run("UPDATE users SET suspended_at = COALESCE(suspended_at, ?), suspended_reason = ? WHERE id = ?", [
    Date.now(),
    reason,
    id,
  ]);
  log(req, "user.suspend", { type: "user", id }, `Suspended @${row.handle}${reason ? ` — ${reason}` : ""}`);
  return getUserRow(id);
};

router.post(
  "/users/:id/suspend",
  userParam,
  validate(z.object({ reason: z.string().trim().max(200).default("") })),
  (req, res) => {
    const row = suspendUser(req, req.params.id, req.body.reason);
    res.json({ suspension: { at: row.suspended_at, reason: row.suspended_reason } });
  },
);

router.delete("/users/:id/suspend", userParam, (req, res) => {
  const row = moderatable(req.params.id, req);
  run("UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?", [row.id]);
  log(req, "user.unsuspend", { type: "user", id: row.id }, `Unsuspended @${row.handle}`);
  res.json({ suspension: null });
});

// Cleans up a profile: `bio` empties it, `avatar` removes the photo, `cover`
// the cover still, `name` resets the display name to the handle.
router.post(
  "/users/:id/clean",
  userParam,
  validate(
    z
      .object({ bio: z.literal(true), avatar: z.literal(true), cover: z.literal(true), name: z.literal(true) })
      .partial()
      .refine((body) => Object.keys(body).length > 0, "Nothing to clean up"),
  ),
  (req, res) => {
    const row = getUserRow(req.params.id);
    if (!row) throw notFound("No such user");
    const { bio, avatar, cover, name } = req.body;
    transaction(() => {
      if (bio) run("UPDATE users SET bio = '' WHERE id = ?", [row.id]);
      if (avatar) run("UPDATE users SET avatar_uri = NULL WHERE id = ?", [row.id]);
      if (cover) run("UPDATE users SET cover_movie_id = NULL WHERE id = ?", [row.id]);
      if (name) run("UPDATE users SET display_name = handle WHERE id = ?", [row.id]);
    });
    const what = [name && `name (was ${quoted(row.display_name)})`, bio && "bio", avatar && "photo", cover && "cover still"].filter(Boolean);
    log(req, "user.clean", { type: "user", id: row.id }, `Cleaned up @${row.handle}'s ${what.join(", ")}`);
    res.json({ user: toProfile(getUserRow(row.id)) });
  },
);

// Removes someone's list (its films stay in their library).
const removeList = (req, id) => {
  const board = get("SELECT boards.name, users.handle FROM boards JOIN users ON users.id = boards.user_id WHERE boards.id = ?", [id]);
  if (!board) throw notFound("No such list");
  run("DELETE FROM boards WHERE id = ?", [id]);
  log(req, "list.remove", { type: "list", id }, `Removed @${board.handle}'s list ${quoted(board.name)}`);
};

router.delete("/boards/:id", validate(z.object({ id: z.string().min(1).max(64) }), "params"), (req, res) => {
  removeList(req, req.params.id);
  res.status(204).end();
});

// Deletes the account and everything in it. Not your own (sign in to the app
// for that).
router.delete("/users/:id", userParam, (req, res) => {
  if (req.params.id === req.userId) throw badRequest("You can't delete your own account here");
  const row = getUserRow(req.params.id);
  if (!row) throw notFound("No such user");
  run("DELETE FROM users WHERE id = ?", [row.id]);
  log(req, "user.delete", { type: "user", id: row.id }, `Deleted @${row.handle}'s account (${row.email})`);
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
    const changes = [
      newVibe && "hand-tuned its vibe",
      franchise !== undefined && (franchise ? `franchise ${quoted(franchise)}` : "cleared its franchise"),
      inPool === true && !movie.inPool && "put it in the pool",
      inPool === false && "took it out of the pool",
    ].filter(Boolean);
    if (changes.length > 0) {
      log(req, "movie.update", { type: "movie", id }, `${movie.title} (${movie.year ?? "?"}): ${changes.join(", ")}`);
    }
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

// A film as the saga editor shows it (its backdrop is a cover choice).
const filmCard = (movie) => ({
  id: movie.id,
  title: movie.title,
  year: movie.year,
  poster: movie.poster,
  backdrop: movie.backdrop ?? null,
  inPool: movie.inPool,
});
const sagaCard = (movieIds) => movieIds.map(getMovieById).filter(Boolean).map(filmCard);

// The curation's entry for a saga (its rule, its ranks as written, its
// picked artwork), if it has one.
const curatedSaga = (id) => readCuration().sagas?.find((item) => `saga-${item.id}` === id) ?? null;

router.get("/sagas", (req, res) => {
  res.json({
    sagas: readSagas().map((saga) => ({ ...saga, ...sagaStats(saga), cover: sagaCard(saga.movieIds.slice(0, 4)) })),
  });
});

const sagaParam = validate(z.object({ id: z.string().regex(/^saga-[a-z0-9-]{1,60}$/) }), "params");

router.get("/sagas/:id", sagaParam, (req, res) => {
  const saga = readSagas().find((item) => item.id === req.params.id);
  if (!saga) throw notFound("No such saga");
  const curated = curatedSaga(saga.id);
  res.json({
    saga,
    stats: sagaStats(saga),
    movies: sagaCard(saga.movieIds),
    from: curated?.from ?? null,
    curated: curated && { ranks: curated.ranks, art: curated.art ?? null },
  });
});

// ---- Saga rules: where its films come from, resolved like build-pool does.

const MIN_FILMS = 3;
const MAX_FILMS = 100;
const { resolveSaga } = createSagaResolver();

const votes = z.number().int().min(0).max(1_000_000).optional();
const top = z.number().int().min(MIN_FILMS).max(MAX_FILMS).optional();
const personName = z.string().trim().min(1).max(80);
// A rule — not films picked one by one (those are `movieIds`).
const ruleFrom = z.union([
  z.object({ tmdbCollections: z.array(z.number().int().positive()).min(1).max(6) }).strict(),
  z.object({ company: z.number().int().positive(), minVotes: votes }).strict(),
  z.object({ director: personName, minVotes: votes, top }).strict(),
  z.object({ actor: personName, minVotes: votes, top }).strict(),
]);

// A rule's films, fetched (so they have posters): { movieIds, movies, art,
// person, source }. Films TMDB has no poster for are left out, as build-pool
// does.
const resolveRule = async (from) => {
  const resolved = await resolveSaga({ from });
  if (resolved.ids.length > MAX_FILMS) {
    throw badRequest(
      `That finds ${resolved.ids.length} films; a saga can have ${MAX_FILMS}. Raise the minimum votes, or keep only the best-known.`,
    );
  }
  const movies = (await ensureMovies(resolved.ids.map(String))).filter((movie) => movie.poster);
  return { movieIds: movies.map((movie) => movie.id), movies, art: resolved.art, person: resolved.person ?? null, source: resolved.source };
};

// `source` names what the rule found ("Harry Potter Collection", "A24").
router.post("/sagas/preview", validate(z.object({ from: ruleFrom })), async (req, res) => {
  const { from } = req.body;
  const rule = await resolveRule(from);
  const company = from.company ? await tmdbGet(`/company/${from.company}`) : null;
  res.json({ movies: rule.movies.map(filmCard), art: rule.art, person: rule.person, source: company?.name ?? rule.source });
});

// TMDB's own search, for building a rule: collections, studios, people.
const SEARCHES = { collection: "/search/collection", company: "/search/company", person: "/search/person" };
const image = (path, size) => (path ? `${IMAGE_BASE}/${size}${path}` : null);
router.get(
  "/tmdb/search",
  validate(z.object({ type: z.enum(["collection", "company", "person"]), q: z.string().trim().min(1).max(80) }), "query"),
  async (req, res) => {
    const { type, q } = req.validQuery;
    const data = await tmdbGet(SEARCHES[type], { query: q, include_adult: "false" });
    const results = (data?.results ?? []).slice(0, 12).map((item) => ({
      id: item.id,
      name: item.name,
      image: image(item.poster_path ?? item.logo_path ?? item.profile_path, "w185"),
      ...(type === "collection" ? { backdrop: image(item.backdrop_path, "w780") } : {}),
      ...(type === "company" ? { country: item.origin_country || null } : {}),
      ...(type === "person"
        ? {
            department: item.known_for_department ?? null,
            knownFor: (item.known_for ?? []).map((movie) => movie.title ?? movie.name).filter(Boolean).slice(0, 3),
          }
        : {}),
    }));
    res.json({ results });
  },
);

// ---- Saving a saga

// A rank: `at` films, or a `share` of them (0.6 = 60%). The last one always
// needs every film, whatever it says.
const rank = z
  .object({
    title: z.string().trim().min(1).max(40),
    at: z.number().int().min(1).optional(),
    share: z.number().gt(0).lt(1).optional(),
  })
  .refine((item) => item.at == null || item.share == null, "A rank needs films or a share, not both");
const tmdbImage = z.string().url().regex(/^https:\/\/image\.tmdb\.org\//, "Expected a TMDB image");
// The saga's picture: a backdrop or a person's photo; null = automatic.
const art = z.union([z.object({ backdrop: tmdbImage }).strict(), z.object({ photo: tmdbImage }).strict()]).nullable();
const sagaFields = {
  title: z.string().trim().min(1).max(60),
  subtitle: z.string().trim().max(120),
  kind: z.enum(["franchise", "studio", "theme", "director", "actor"]),
  // Its films: picked one by one, or a rule for them.
  movieIds: z
    .array(movieId)
    .min(MIN_FILMS)
    .max(MAX_FILMS)
    .refine((ids) => new Set(ids).size === ids.length, "Films must be unique")
    .optional(),
  from: ruleFrom.optional(),
  ranks: z.array(rank).min(1).max(5),
  art: art.optional(),
};

// Ranks as the curation keeps them (`at` a count or "all", or a `share`)
// and as film counts — in order, each needing more than the one before,
// the last every film.
const planRanks = (ranks, total) => {
  const curated = ranks.map((item, i) =>
    i === ranks.length - 1
      ? { title: item.title, at: "all" }
      : item.share != null
        ? { title: item.title, share: item.share }
        : { title: item.title, at: item.at ?? 1 },
  );
  const counts = resolveExactRanks(curated, total);
  counts.forEach((item, i) => {
    if (item.at > total) throw badRequest(`"${item.title}" needs ${item.at} films — the saga has ${total}`);
    if (i > 0 && item.at <= counts[i - 1].at) {
      throw badRequest(`"${item.title}" has to need more films than "${counts[i - 1].title}"`);
    }
  });
  return { curated, counts };
};
const resolveExactRanks = (curated, total) =>
  curated.map((item) => ({
    title: item.title,
    at: item.at === "all" ? total : item.share != null ? Math.max(1, Math.ceil(item.share * total)) : item.at,
  }));

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

// A saga's films from what was sent — a rule, or films picked here:
// { movieIds, movies, from, ruleArt, person }, every film in the pool.
const sagaFilms = async ({ from, movieIds }) => {
  if (from) {
    const rule = await resolveRule(from);
    if (rule.movieIds.length < MIN_FILMS) {
      throw badRequest(`That finds ${rule.movieIds.length} films; a saga needs at least ${MIN_FILMS}`);
    }
    const movies = await poolFilms(rule.movieIds);
    return { movieIds: rule.movieIds, movies, from, ruleArt: rule.art, person: rule.person };
  }
  if (!movieIds) throw badRequest("Pick its films, or a rule for them");
  return { movieIds, movies: await poolFilms(movieIds), from: { ids: movieIds }, ruleArt: null, person: null };
};

// The best-known film's backdrop, for a saga without its own artwork.
const fallbackArt = (movies) => {
  const backdrop = [...movies]
    .filter((movie) => movie.backdrop)
    .sort((a, b) => (b.details?.votes ?? 0) - (a.details?.votes ?? 0))[0]?.backdrop;
  return backdrop ? { backdrop } : null;
};

// The curation's version of a saga: its rule (or picked ids), its ranks as
// written, and its artwork if one was picked. An actor's or a director's
// saga with picked films keeps who it's about.
const toCurated = (saga, { from, ranks, art: picked }) => ({
  id: saga.id.replace(/^saga-/, ""),
  title: saga.title,
  subtitle: saga.subtitle,
  kind: saga.kind,
  from,
  ...(saga.person && from.ids ? { person: saga.person } : {}),
  ...(picked ? { art: picked } : {}),
  ranks,
});

const saveSagas = (sagas) => {
  writeSagas(sagas);
  refresh();
};

router.post(
  "/sagas",
  validate(z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/), ...sagaFields, subtitle: sagaFields.subtitle.default("") })),
  async (req, res) => {
    const { id, title, subtitle, kind, ranks } = req.body;
    const sagas = readSagas();
    if (sagas.some((saga) => saga.id === `saga-${id}`)) throw badRequest("A saga with that id exists");
    const films = await sagaFilms(req.body);
    const plan = planRanks(ranks, films.movieIds.length);
    const picked = req.body.art ?? null;
    const saga = {
      id: `saga-${id}`,
      type: SAGA,
      kind,
      title,
      subtitle,
      movieIds: films.movieIds,
      ranks: plan.counts,
      art: picked ?? films.ruleArt ?? fallbackArt(films.movies),
      ...(films.person ? { person: films.person } : {}),
    };
    updateCuration((curation) => {
      curation.sagas = [...(curation.sagas ?? []), toCurated(saga, { from: films.from, ranks: plan.curated, art: picked })];
    });
    saveSagas([...sagas, saga]);
    log(req, "saga.create", { type: "saga", id: saga.id }, `Created the collection ${quoted(title)} (${saga.movieIds.length} films)`);
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
    const curated = curatedSaga(current.id);

    // Its films: a new rule, new picks, or as they were. Picks that match
    // the films it has keep the rule they came from.
    let from = curated?.from ?? { ids: current.movieIds };
    let movieIds = current.movieIds;
    let ruleArt = null;
    // Who it's about (sagas built before build-pool stored it: from the
    // curation), kept when its films become a picked list.
    let person = current.person ?? curated?.from?.actor ?? curated?.from?.director ?? curated?.person;
    if (changes.from || changes.movieIds) {
      const films = await sagaFilms(changes);
      if (changes.from || films.movieIds.join() !== current.movieIds.join()) {
        ({ from, movieIds, ruleArt } = films);
        person = films.person ?? person;
      }
    }
    const filmsChanged = movieIds.join() !== current.movieIds.join();

    // Its ranks: new ones checked strictly; the ones it has re-counted when
    // its films changed (a smaller saga keeps its higher ranks).
    const written =
      curated?.ranks ??
      current.ranks.map((item, i, list) => ({ title: item.title, at: i === list.length - 1 ? "all" : item.at }));
    const plan = changes.ranks
      ? planRanks(changes.ranks, movieIds.length)
      : { curated: written, counts: filmsChanged ? resolveRanks(written, movieIds.length) : current.ranks };

    // Its picture: the one picked, or worked out again when its films or
    // the pick changed.
    const picked = changes.art !== undefined ? changes.art : (curated?.art ?? null);
    let sagaArt = current.art;
    if (picked) sagaArt = picked;
    else if (filmsChanged || changes.from || changes.art === null) {
      if (!ruleArt && !from.ids && !from.movies) ruleArt = (await resolveRule(from)).art;
      sagaArt = ruleArt ?? fallbackArt(movieIds.map(getMovieById).filter(Boolean));
    }

    const saga = {
      ...current,
      title: changes.title ?? current.title,
      subtitle: changes.subtitle ?? current.subtitle,
      kind: changes.kind ?? current.kind,
      ...(person ? { person } : {}),
      movieIds,
      ranks: plan.counts,
      art: sagaArt,
    };
    updateCuration((curation) => {
      const list = curation.sagas ?? [];
      const at = list.findIndex((item) => `saga-${item.id}` === saga.id);
      const entry = toCurated(saga, { from, ranks: plan.curated, art: picked });
      if (at === -1) list.push(entry);
      else list[at] = entry;
      curation.sagas = list;
    });
    sagas[index] = saga;
    saveSagas(sagas);
    const edited = [
      saga.title !== current.title && `renamed from ${quoted(current.title)}`,
      (saga.subtitle !== current.subtitle || saga.kind !== current.kind) && "details",
      filmsChanged && `films (${current.movieIds.length} → ${movieIds.length})`,
      changes.from && !filmsChanged && "its rule",
      changes.ranks && "ranks",
      changes.art !== undefined && "picture",
    ].filter(Boolean);
    log(req, "saga.update", { type: "saga", id: saga.id }, `Edited the collection ${quoted(saga.title)}${edited.length ? `: ${edited.join(", ")}` : ""}`);
    res.json({ saga, stats: sagaStats(saga), movies: sagaCard(saga.movieIds) });
  },
);

router.delete("/sagas/:id", sagaParam, (req, res) => {
  const sagas = readSagas();
  const gone = sagas.find((saga) => saga.id === req.params.id);
  if (!gone) return res.status(204).end();
  updateCuration((curation) => {
    curation.sagas = (curation.sagas ?? []).filter((item) => `saga-${item.id}` !== req.params.id);
  });
  saveSagas(sagas.filter((saga) => saga.id !== req.params.id));
  log(req, "saga.delete", { type: "saga", id: gone.id }, `Deleted the collection ${quoted(gone.title)}`);
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

const clubParam = validate(z.object({ id: z.string().min(1).max(64) }), "params");
const loadClub = (id) => {
  const club = get("SELECT * FROM clubs WHERE id = ?", [id]);
  if (!club) throw notFound("No such club");
  return club;
};

// A club whole: its name and description, members, and the films on its
// shared board (who added each).
router.get("/clubs/:id", clubParam, (req, res) => {
  const club = loadClub(req.params.id);
  const members = all(
    `SELECT users.id, users.display_name, users.handle, users.color, users.avatar_uri, users.suspended_at,
            club_members.role, club_members.joined_at
     FROM club_members JOIN users ON users.id = club_members.user_id
     WHERE club_members.club_id = ? ORDER BY club_members.role = 'owner' DESC, club_members.joined_at`,
    [club.id],
  ).map((row) => ({
    id: row.id,
    name: row.display_name,
    handle: `@${row.handle}`,
    color: row.color,
    avatarUri: row.avatar_uri,
    role: row.role,
    joinedAt: row.joined_at,
    suspended: row.suspended_at != null,
  }));
  const movies = all(
    `SELECT club_movies.movie_id, club_movies.added_at, users.display_name AS added_by_name, users.handle AS added_by_handle
     FROM club_movies LEFT JOIN users ON users.id = club_movies.added_by
     WHERE club_movies.club_id = ? ORDER BY club_movies.added_at DESC, club_movies.rowid DESC`,
    [club.id],
  ).map((row) => {
    const movie = getMovieById(row.movie_id);
    return {
      id: row.movie_id,
      title: movie?.title ?? `Movie ${row.movie_id}`,
      year: movie?.year ?? null,
      poster: movie?.poster ?? null,
      addedAt: row.added_at,
      addedBy: row.added_by_handle ? { name: row.added_by_name, handle: `@${row.added_by_handle}` } : null,
    };
  });
  res.json({
    club: {
      id: club.id,
      name: club.name,
      description: club.description,
      ownerId: club.owner_id,
      nowWatchingId: club.now_watching_movie_id,
      createdAt: club.created_at,
    },
    members,
    movies,
  });
});

// Rename it or change (or empty) its description.
router.patch(
  "/clubs/:id",
  clubParam,
  validate(
    z
      .object({ name: z.string().trim().min(1).max(CLUB_NAME_MAX), description: z.string().trim().max(CLUB_DESCRIPTION_MAX) })
      .partial()
      .refine((body) => Object.keys(body).length > 0, "Nothing to change"),
  ),
  (req, res) => {
    const club = loadClub(req.params.id);
    const { name, description } = req.body;
    transaction(() => {
      if (name !== undefined) run("UPDATE clubs SET name = ? WHERE id = ?", [name, club.id]);
      if (description !== undefined) run("UPDATE clubs SET description = ? WHERE id = ?", [description, club.id]);
    });
    const updated = loadClub(club.id);
    const edited = [
      name !== undefined && name !== club.name && `renamed from ${quoted(club.name)}`,
      description !== undefined && description !== club.description && (description ? "changed its description" : "cleared its description"),
    ].filter(Boolean);
    if (edited.length > 0) log(req, "club.update", { type: "club", id: club.id }, `Club ${quoted(updated.name)}: ${edited.join(", ")}`);
    res.json({ club: { id: updated.id, name: updated.name, description: updated.description } });
  },
);

// Takes a film off a club's board (and off "now watching", if it was).
router.delete(
  "/clubs/:id/movies/:movieId",
  validate(z.object({ id: z.string().min(1).max(64), movieId }), "params"),
  (req, res) => {
    const club = loadClub(req.params.id);
    transaction(() => {
      run("DELETE FROM club_movies WHERE club_id = ? AND movie_id = ?", [club.id, req.params.movieId]);
      if (club.now_watching_movie_id === req.params.movieId) {
        run("UPDATE clubs SET now_watching_movie_id = NULL, now_watching_set_at = NULL WHERE id = ?", [club.id]);
      }
    });
    const title = getMovieById(req.params.movieId)?.title ?? `movie ${req.params.movieId}`;
    log(req, "club.film", { type: "club", id: club.id }, `Took ${quoted(title)} off the club ${quoted(club.name)}'s board`);
    res.status(204).end();
  },
);

const removeClub = (req, id) => {
  const club = get("SELECT clubs.name, users.handle FROM clubs JOIN users ON users.id = clubs.owner_id WHERE clubs.id = ?", [id]);
  if (!club) return;
  run("DELETE FROM clubs WHERE id = ?", [id]);
  log(req, "club.remove", { type: "club", id }, `Removed @${club.handle}'s club ${quoted(club.name)}`);
};

router.delete("/clubs/:id", clubParam, (req, res) => {
  removeClub(req, req.params.id);
  res.status(204).end();
});

// ---- Reports -------------------------------------------------------------------
//
// What people reported from the app (routes/reports.js), grouped by what
// was reported — each group a "case": the reported thing as it is now, its
// owner, and every report about it. An admin closes a case all at once:
// dismissed (nothing wrong), handled (fixed by hand, e.g. a cleaned-up
// profile), the list or club removed, or its owner suspended.

const REASON_LABELS = {
  spam: "spam",
  offensive: "offensive",
  harassment: "harassment",
  impersonation: "impersonation",
  other: "other",
};
const personOf = (id) => {
  const row = id ? getUserRow(id) : null;
  return row ? { id: row.id, name: row.display_name, handle: `@${row.handle}`, suspended: isSuspended(row) } : null;
};

// The reported thing as it is now, or null if it's gone.
const reportedNow = (type, id) => {
  if (type === "user") {
    const row = getUserRow(id);
    return row && { label: `${row.display_name} (@${row.handle})`, bio: row.bio, avatarUri: row.avatar_uri };
  }
  if (type === "list") {
    const row = get("SELECT * FROM boards WHERE id = ?", [id]);
    if (!row) return null;
    const board = toBoard(row);
    return {
      label: board.name,
      movieCount: board.movieIds.length,
      posters: board.movieIds.slice(0, 6).map((movie) => getMovieById(movie)?.poster ?? null),
    };
  }
  const club = get("SELECT * FROM clubs WHERE id = ?", [id]);
  return (
    club && {
      label: club.name,
      description: club.description,
      memberCount: count("SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?", [club.id]),
    }
  );
};
const describeTarget = (type, label) => (type === "user" ? label : `${type} ${quoted(label)}`);
const openCaseCount = () =>
  get("SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports WHERE status = 'open' GROUP BY target_type, target_id)").n;

router.get("/reports/count", (req, res) => {
  res.json({ open: openCaseCount() });
});

router.get(
  "/reports",
  validate(z.object({ status: z.enum(["open", "actioned", "dismissed"]).default("open") }), "query"),
  (req, res) => {
    const { status } = req.validQuery;
    const rows = all(
      `SELECT * FROM reports WHERE status = ? ORDER BY ${status === "open" ? "created_at" : "resolved_at"} DESC LIMIT 500`,
      [status],
    );
    const groups = new Map();
    rows.forEach((row) => {
      const key = `${row.target_type}:${row.target_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    const cases = [...groups.entries()].map(([key, list]) => {
      const [first] = list;
      const now = reportedNow(first.target_type, first.target_id);
      return {
        key,
        targetType: first.target_type,
        targetId: first.target_id,
        label: now?.label ?? first.target_label,
        gone: !now,
        target: now,
        owner: personOf(first.owner_id),
        lastAt: Math.max(...list.map((row) => row.created_at)),
        resolvedAt: first.resolved_at,
        resolution: first.resolution,
        resolvedBy: personOf(first.resolved_by),
        reports: list.map((row) => ({
          id: row.id,
          reason: row.reason,
          note: row.note,
          reporter: personOf(row.reporter_id),
          createdAt: row.created_at,
        })),
      };
    });
    if (status === "open") cases.sort((a, b) => b.reports.length - a.reports.length || b.lastAt - a.lastAt);
    res.json({ cases, open: openCaseCount() });
  },
);

router.post(
  "/reports/resolve",
  validate(
    z.object({
      targetType: z.enum(["user", "list", "club"]),
      targetId: z.string().min(1).max(64),
      action: z.enum(["dismiss", "handled", "remove", "suspend"]),
      note: z.string().trim().max(300).default(""),
    }),
  ),
  (req, res) => {
    const { targetType, targetId, action, note } = req.body;
    const open = all("SELECT * FROM reports WHERE status = 'open' AND target_type = ? AND target_id = ?", [targetType, targetId]);
    if (open.length === 0) throw notFound("No open reports about that");
    const now = reportedNow(targetType, targetId);
    const what = describeTarget(targetType, now?.label ?? open[0].target_label);

    let resolution;
    if (action === "remove") {
      if (targetType === "user") throw badRequest("A person can't be removed — clean up their profile, or suspend them");
      if (now) {
        if (targetType === "list") removeList(req, targetId);
        else removeClub(req, targetId);
      }
      resolution = targetType === "list" ? "Removed the list" : "Removed the club";
    } else if (action === "suspend") {
      const reasons = [...new Set(open.map((row) => REASON_LABELS[row.reason]))].join(", ");
      const row = suspendUser(req, open[0].owner_id, `Reported for ${reasons}${note ? ` — ${note}` : ""}`);
      resolution = `Suspended @${row.handle}`;
    } else {
      resolution = action === "dismiss" ? "Dismissed" : "Handled";
    }
    if (note && action !== "suspend") resolution += ` — ${note}`;

    run(
      `UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?
       WHERE status = 'open' AND target_type = ? AND target_id = ?`,
      [action === "dismiss" ? "dismissed" : "actioned", Date.now(), req.userId, resolution, targetType, targetId],
    );
    const reports = `${open.length} ${open.length === 1 ? "report" : "reports"}`;
    log(
      req,
      `report.${action}`,
      { type: targetType, id: targetId },
      `${action === "dismiss" ? "Dismissed" : "Closed"} ${reports} about ${what}: ${resolution}`,
    );
    res.json({ resolution, open: openCaseCount() });
  },
);

// ---- The log -------------------------------------------------------------------

router.get(
  "/log",
  validate(z.object({ action: z.string().trim().max(40).optional(), page, limit: limit(100, 50) }), "query"),
  (req, res) => {
    const { action, page: pageNumber, limit: size } = req.validQuery;
    const { entries, total } = listAdminLog({ action: action || undefined, limit: size, offset: (pageNumber - 1) * size });
    res.json({ entries, page: pageNumber, total, totalPages: Math.max(1, Math.ceil(total / size)) });
  },
);

export default router;
