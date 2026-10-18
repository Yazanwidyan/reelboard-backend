import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, get, run, transaction } from "../db/index.js";
import { listActivity } from "../lib/activity.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { ensureMovie, ensureMovies, moviesFor } from "../lib/movies.js";
import { movieId, uniqueIds } from "../lib/schemas.js";
import { toPublicUser } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/clubs. A club is a group of people with a shared board,
// a "now watching" pick (set by the owner — the club's challenge), a club
// tier list and a feed. Clubs are private: you join with an invite code,
// and only members can see a club. Members see each other's tiers for the
// club's movies only, and the feed only covers those movies.
const router = Router();

export const CLUB_NAME_MAX = 40;
export const CLUB_DESCRIPTION_MAX = 200;
export const MAX_CLUBS_PER_USER = 20;
export const MAX_CLUB_MEMBERS = 100;
export const MAX_CLUB_MOVIES = 500;

// 8 characters, no look-alikes (0/O, 1/I/L) — easy to read out or type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newInviteCode = () =>
  Array.from(crypto.randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");

const name = z.string().trim().min(1).max(CLUB_NAME_MAX);
const description = z.string().trim().max(CLUB_DESCRIPTION_MAX);
const idParam = z.object({ id: z.string().min(1).max(64) });

const membership = (clubId, userId) =>
  get("SELECT role FROM club_members WHERE club_id = ? AND user_id = ?", [clubId, userId]);

// The club, if you're in it. Strangers get the same 404 as a missing club.
const loadClub = (clubId, userId, { owner = false } = {}) => {
  const club = get("SELECT * FROM clubs WHERE id = ?", [clubId]);
  const member = club && membership(clubId, userId);
  if (!club || !member) throw notFound("No such club");
  if (owner && member.role !== "owner") throw forbidden("Only the club's owner can do that");
  return club;
};

const memberIdsOf = (clubId) =>
  all("SELECT user_id FROM club_members WHERE club_id = ?", [clubId]).map((row) => row.user_id);

const clubMovieIds = (club) => {
  const ids = all("SELECT movie_id FROM club_movies WHERE club_id = ? ORDER BY added_at, rowid", [
    club.id,
  ]).map((row) => row.movie_id);
  if (club.now_watching_movie_id && !ids.includes(club.now_watching_movie_id)) {
    ids.push(club.now_watching_movie_id);
  }
  return ids;
};

// Members' watched entries for these movies: { [movieId]: [{ userId, tier }] }
const memberWatches = (memberIds, movieIds) => {
  const byMovie = Object.fromEntries(movieIds.map((id) => [id, []]));
  if (memberIds.length === 0 || movieIds.length === 0) return byMovie;
  const list = (ids) => ids.map(() => "?").join(", ");
  for (const row of all(
    `SELECT user_id, movie_id, tier FROM watched
     WHERE user_id IN (${list(memberIds)}) AND movie_id IN (${list(movieIds)})`,
    [...memberIds, ...movieIds],
  )) {
    byMovie[row.movie_id].push({ userId: row.user_id, tier: row.tier });
  }
  return byMovie;
};

// In a list of clubs: the summary.
const toSummary = (club, role) => ({
  id: club.id,
  name: club.name,
  description: club.description,
  role,
  memberCount: get("SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?", [club.id]).n,
  // The board's movies, so a movie page can show which clubs have it.
  movieIds: all("SELECT movie_id FROM club_movies WHERE club_id = ? ORDER BY added_at, rowid", [
    club.id,
  ]).map((row) => row.movie_id),
  nowWatching: club.now_watching_movie_id,
  createdAt: club.created_at,
});

// One club, in full, as a member sees it.
const toDetail = (club, userId) => {
  const members = all(
    `SELECT users.*, club_members.role, club_members.joined_at FROM club_members
     JOIN users ON users.id = club_members.user_id
     WHERE club_members.club_id = ?
     ORDER BY club_members.role = 'owner' DESC, club_members.joined_at`,
    [club.id],
  ).map((row) => ({ ...toPublicUser(row), role: row.role, joinedAt: row.joined_at }));
  const watches = memberWatches(
    members.map((member) => member.id),
    clubMovieIds(club),
  );
  return {
    ...toSummary(club, membership(club.id, userId).role),
    ownerId: club.owner_id,
    inviteCode: club.invite_code,
    members,
    movies: all(
      "SELECT movie_id, added_by, added_at FROM club_movies WHERE club_id = ? ORDER BY added_at, rowid",
      [club.id],
    ).map((row) => ({
      movieId: row.movie_id,
      addedBy: row.added_by,
      addedAt: row.added_at,
      watches: watches[row.movie_id] ?? [],
    })),
    nowWatching: club.now_watching_movie_id
      ? {
          movieId: club.now_watching_movie_id,
          setAt: club.now_watching_set_at,
          watches: watches[club.now_watching_movie_id] ?? [],
        }
      : null,
  };
};

const reload = (clubId) => get("SELECT * FROM clubs WHERE id = ?", [clubId]);

// A club in a response, with its movies that aren't in the pool (so the
// app can show them).
const withMovies = (club) => ({
  club,
  movies: moviesFor([
    ...club.movies.map((entry) => entry.movieId),
    club.nowWatching?.movieId,
  ]),
});

const assertRoomForAnotherClub = (userId) => {
  const { n } = get("SELECT COUNT(*) AS n FROM club_members WHERE user_id = ?", [userId]);
  if (n >= MAX_CLUBS_PER_USER) throw conflict(`You can be in up to ${MAX_CLUBS_PER_USER} clubs`);
};

// ---- Your clubs ------------------------------------------------------------

router.get("/", (req, res) => {
  const clubs = all(
    `SELECT clubs.*, club_members.role FROM club_members
     JOIN clubs ON clubs.id = club_members.club_id
     WHERE club_members.user_id = ?
     ORDER BY club_members.joined_at DESC`,
    [req.userId],
  ).map((row) => toSummary(row, row.role));
  res.json({
    clubs,
    movies: moviesFor(clubs.flatMap((club) => [...club.movieIds, club.nowWatching])),
  });
});

router.post(
  "/",
  validate(
    z.object({
      name,
      description: description.default(""),
      movieIds: uniqueIds(movieId, MAX_CLUB_MOVIES).default([]),
    }),
  ),
  async (req, res) => {
    assertRoomForAnotherClub(req.userId);
    await ensureMovies(req.body.movieIds, { strict: true });
    const id = newId("cl");
    const now = Date.now();
    transaction(() => {
      run(
        `INSERT INTO clubs (id, name, description, owner_id, invite_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.body.name, req.body.description, req.userId, newInviteCode(), now],
      );
      run("INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", [
        id,
        req.userId,
        now,
      ]);
      req.body.movieIds.forEach((movie, index) => {
        run("INSERT INTO club_movies (club_id, movie_id, added_by, added_at) VALUES (?, ?, ?, ?)", [
          id,
          movie,
          req.userId,
          now + index,
        ]);
      });
    });
    res.status(201).json(withMovies(toDetail(reload(id), req.userId)));
  },
);

// Join with an invite code. Joining a club you're already in returns it.
router.post(
  "/join",
  validate(z.object({ code: z.string().trim().toUpperCase().min(4).max(20) })),
  (req, res) => {
    const club = get("SELECT * FROM clubs WHERE invite_code = ?", [req.body.code]);
    if (!club) throw notFound("No club has that invite code");
    if (membership(club.id, req.userId)) return res.json(withMovies(toDetail(club, req.userId)));
    assertRoomForAnotherClub(req.userId);
    if (memberIdsOf(club.id).length >= MAX_CLUB_MEMBERS) throw conflict("That club is full");
    run("INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", [
      club.id,
      req.userId,
      Date.now(),
    ]);
    res.status(201).json(withMovies(toDetail(club, req.userId)));
  },
);

// ---- One club ---------------------------------------------------------------

router.get("/:id", validate(idParam, "params"), (req, res) => {
  res.json(withMovies(toDetail(loadClub(req.params.id, req.userId), req.userId)));
});

// Owner: rename, describe, or set (null clears) what the club is watching.
router.patch(
  "/:id",
  validate(idParam, "params"),
  validate(
    z
      .object({ name, description, nowWatching: movieId.nullable() })
      .partial()
      .refine((body) => Object.keys(body).length > 0, "Nothing to update"),
  ),
  async (req, res) => {
    const club = loadClub(req.params.id, req.userId, { owner: true });
    const { name: newName, description: newDescription, nowWatching } = req.body;
    if (nowWatching) await ensureMovie(nowWatching);
    run(
      `UPDATE clubs SET name = ?, description = ?, now_watching_movie_id = ?, now_watching_set_at = ?
       WHERE id = ?`,
      [
        newName ?? club.name,
        newDescription ?? club.description,
        nowWatching === undefined ? club.now_watching_movie_id : nowWatching,
        nowWatching === undefined ? club.now_watching_set_at : nowWatching ? Date.now() : null,
        club.id,
      ],
    );
    res.json(withMovies(toDetail(reload(club.id), req.userId)));
  },
);

// Owner: delete the club for everyone. Already gone (a retry) is fine.
router.delete("/:id", validate(idParam, "params"), (req, res) => {
  if (!get("SELECT 1 FROM clubs WHERE id = ?", [req.params.id])) return res.status(204).end();
  loadClub(req.params.id, req.userId, { owner: true });
  run("DELETE FROM clubs WHERE id = ?", [req.params.id]);
  res.status(204).end();
});

// Leave a club. The owner can't — they'd leave it without one — so they
// delete it instead. Not in it (any more) is fine.
router.post("/:id/leave", validate(idParam, "params"), (req, res) => {
  const member = membership(req.params.id, req.userId);
  if (!member) return res.status(204).end();
  if (member.role === "owner") {
    throw badRequest("You own this club — delete it instead of leaving");
  }
  run("DELETE FROM club_members WHERE club_id = ? AND user_id = ?", [req.params.id, req.userId]);
  res.status(204).end();
});

// Owner: a new invite code (the old one stops working).
router.post("/:id/invite", validate(idParam, "params"), (req, res) => {
  const club = loadClub(req.params.id, req.userId, { owner: true });
  const inviteCode = newInviteCode();
  run("UPDATE clubs SET invite_code = ? WHERE id = ?", [inviteCode, club.id]);
  res.json({ inviteCode });
});

// Owner: remove a member. Already gone is fine.
router.delete(
  "/:id/members/:userId",
  validate(z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) }), "params"),
  (req, res) => {
    const club = loadClub(req.params.id, req.userId, { owner: true });
    if (req.params.userId === req.userId) throw badRequest("You can't remove yourself");
    run("DELETE FROM club_members WHERE club_id = ? AND user_id = ?", [club.id, req.params.userId]);
    res.json(withMovies(toDetail(reload(club.id), req.userId)));
  },
);

// ---- The club's board -------------------------------------------------------

// Any member adds a movie (already there is fine).
router.post(
  "/:id/movies",
  validate(idParam, "params"),
  validate(z.object({ movieId })),
  async (req, res) => {
    const club = loadClub(req.params.id, req.userId);
    await ensureMovie(req.body.movieId);
    const { n } = get("SELECT COUNT(*) AS n FROM club_movies WHERE club_id = ?", [club.id]);
    if (n >= MAX_CLUB_MOVIES) throw conflict("The club's board is full");
    run(
      `INSERT OR IGNORE INTO club_movies (club_id, movie_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`,
      [club.id, req.body.movieId, req.userId, Date.now()],
    );
    res.json(withMovies(toDetail(reload(club.id), req.userId)));
  },
);

// Whoever added it, or the owner, can take it off. Already off is fine.
router.delete(
  "/:id/movies/:movieId",
  validate(z.object({ id: z.string().min(1).max(64), movieId }), "params"),
  (req, res) => {
    const club = loadClub(req.params.id, req.userId);
    const entry = get("SELECT added_by FROM club_movies WHERE club_id = ? AND movie_id = ?", [
      club.id,
      req.params.movieId,
    ]);
    if (entry) {
      const isOwner = membership(club.id, req.userId).role === "owner";
      if (!isOwner && entry.added_by !== req.userId) {
        throw forbidden("Only whoever added it, or the club's owner, can remove it");
      }
      run("DELETE FROM club_movies WHERE club_id = ? AND movie_id = ?", [club.id, req.params.movieId]);
    }
    res.json(withMovies(toDetail(reload(club.id), req.userId)));
  },
);

// ---- The club's feed --------------------------------------------------------

// What members have done with the club's movies, newest first.
router.get(
  "/:id/activity",
  validate(idParam, "params"),
  validate(
    z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
    "query",
  ),
  (req, res) => {
    const club = loadClub(req.params.id, req.userId);
    const { before, limit } = req.validQuery;
    const activity = listActivity(memberIdsOf(club.id), {
      before,
      limit,
      movieIds: clubMovieIds(club),
    });
    res.json({ activity, movies: moviesFor(activity.map((event) => event.movieId)) });
  },
);

export default router;
