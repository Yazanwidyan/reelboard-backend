import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, fromJSON, get, run, toJSON, transaction } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { assertMovie } from "../lib/movies.js";
import { notify } from "../lib/push.js";
import { movieId, uniqueIds } from "../lib/schemas.js";
import { getUserRow, toPublicUser } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/movie-nights — movie night across phones.
//
// The host creates a room with a stack of movies and gets a short code to
// share. Friends join with it, everyone swipes the same stack on their own
// phone, and nobody sees anyone else's picks until everyone is done (or the
// host ends it) — then the movies everyone kept are revealed. Rooms last
// MOVIE_NIGHT_HOURS; the app polls GET /:id while it waits.

export const MOVIE_NIGHT_HOURS = 12;
export const MAX_MEMBERS = 8;
const MIN_MOVIES = 4;
const MAX_MOVIES = 30;
// No 0/O, 1/I/L — easy to read out and type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const router = Router();

// Notifications about a movie night open the room in the app.
const movieNightLink = (code) => `reelboard://night/${code}`;
const nameOf = (userId) => getUserRow(userId)?.display_name ?? "Someone";

const newCode = () => {
  for (;;) {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    if (!get("SELECT 1 FROM movie_nights WHERE code = ?", [code])) return code;
  }
};

const loadNight = (nightId) => {
  const night = get("SELECT * FROM movie_nights WHERE id = ?", [nightId]);
  if (!night || night.expires_at < Date.now()) throw notFound("This movie night has ended");
  return night;
};

const membersOf = (nightId) =>
  all(
    `SELECT members.*, users.id AS uid, users.display_name, users.handle, users.color,
            users.level, users.avatar_uri, users.bio
     FROM movie_night_members AS members JOIN users ON users.id = members.user_id
     WHERE members.night_id = ? ORDER BY members.joined_at`,
    [nightId],
  );

// What one member sees. Other people's picks stay hidden until the results
// are out: everyone (2+) done, or the host ended it.
const toState = (night, userId) => {
  const members = membersOf(night.id);
  const me = members.find((member) => member.user_id === userId);
  if (!me) throw notFound("This movie night has ended");
  const movieIds = fromJSON(night.movie_ids, []);
  const done = members.filter((member) => member.done_at != null);
  const everyoneDone = members.length >= 2 && done.length === members.length;
  const revealed = everyoneDone || night.status === "closed";

  let results = null;
  if (revealed) {
    const picks = done.map((member) => new Set(fromJSON(member.kept, [])));
    const counts = Object.fromEntries(
      movieIds.map((id) => [id, picks.filter((kept) => kept.has(id)).length]),
    );
    results = {
      everyoneDone,
      // Kept by everyone who finished — at least two of them.
      matches: picks.length >= 2 ? movieIds.filter((id) => counts[id] === picks.length) : [],
      counts,
      voters: picks.length,
    };
  }

  return {
    id: night.id,
    code: night.code,
    hostId: night.host_id,
    isHost: night.host_id === userId,
    movieIds,
    status: night.status,
    createdAt: night.created_at,
    expiresAt: night.expires_at,
    members: members.map((member) => ({
      user: toPublicUser({ ...member, id: member.uid }),
      isHost: member.user_id === night.host_id,
      done: member.done_at != null,
    })),
    me: { kept: fromJSON(me.kept, null), done: me.done_at != null },
    results,
  };
};

const respond = (res, nightId, userId, status = 200) =>
  res.status(status).json({ night: toState(loadNight(nightId), userId) });

// Start one: the host is its first member.
router.post(
  "/",
  validate(
    z.object({
      movieIds: uniqueIds(movieId, MAX_MOVIES).refine(
        (ids) => ids.length >= MIN_MOVIES,
        `At least ${MIN_MOVIES} movies`,
      ),
    }),
  ),
  (req, res) => {
    req.body.movieIds.forEach(assertMovie);
    const id = newId("n");
    const now = Date.now();
    transaction(() => {
      run(
        `INSERT INTO movie_nights (id, code, host_id, movie_ids, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        [id, newCode(), req.userId, toJSON(req.body.movieIds), now, now + MOVIE_NIGHT_HOURS * 3600 * 1000],
      );
      run("INSERT INTO movie_night_members (night_id, user_id, joined_at) VALUES (?, ?, ?)", [
        id,
        req.userId,
        now,
      ]);
    });
    respond(res, id, req.userId, 201);
  },
);

// Join with the code (any case; joining twice is fine).
router.post(
  "/join",
  validate(z.object({ code: z.string().trim().toUpperCase().length(CODE_LENGTH) })),
  (req, res) => {
    const night = get("SELECT * FROM movie_nights WHERE code = ?", [req.body.code]);
    if (!night || night.expires_at < Date.now()) throw notFound("No movie night with that code");
    const already = get(
      "SELECT 1 FROM movie_night_members WHERE night_id = ? AND user_id = ?",
      [night.id, req.userId],
    );
    if (!already) {
      if (night.status === "closed") throw conflict("This movie night is already over");
      const count = get("SELECT COUNT(*) AS n FROM movie_night_members WHERE night_id = ?", [
        night.id,
      ]).n;
      if (count >= MAX_MEMBERS) throw conflict(`This movie night is full (${MAX_MEMBERS} people)`);
      run("INSERT INTO movie_night_members (night_id, user_id, joined_at) VALUES (?, ?, ?)", [
        night.id,
        req.userId,
        Date.now(),
      ]);
      notify([night.host_id], "movieNightJoined", [nameOf(req.userId)], movieNightLink(night.code));
    }
    respond(res, night.id, req.userId);
  },
);

const idParam = z.object({ id: z.string().min(1).max(40) });

router.get("/:id", validate(idParam, "params"), (req, res) => {
  respond(res, req.params.id, req.userId);
});

// Your picks — the movies you kept. Sending them marks you done; sending
// again (a retry, or changing your mind before the reveal) replaces them.
router.put(
  "/:id/picks",
  validate(idParam, "params"),
  validate(z.object({ kept: uniqueIds(movieId, MAX_MOVIES) })),
  (req, res) => {
    const night = loadNight(req.params.id);
    toState(night, req.userId); // members only
    if (night.status === "closed") throw conflict("This movie night is already over");
    const stack = new Set(fromJSON(night.movie_ids, []));
    const stray = req.body.kept.find((id) => !stack.has(id));
    if (stray) throw badRequest(`${stray} isn't in this movie night`);
    const wasRevealed = toState(night, req.userId).results !== null;
    run(
      `UPDATE movie_night_members SET kept = ?, done_at = ?
       WHERE night_id = ? AND user_id = ?`,
      [toJSON(req.body.kept), Date.now(), night.id, req.userId],
    );
    // The last one to finish: tell everyone else the results are in.
    const state = toState(night, req.userId);
    if (!wasRevealed && state.results) {
      const others = state.members.map((member) => member.user.id).filter((id) => id !== req.userId);
      notify(others, "movieNightResults", [], movieNightLink(night.code));
    }
    res.json({ night: state });
  },
);

// The host can end it early — results then come from whoever finished.
router.post("/:id/close", validate(idParam, "params"), (req, res) => {
  const night = loadNight(req.params.id);
  if (night.host_id !== req.userId) throw forbidden("Only the host can end the movie night");
  run("UPDATE movie_nights SET status = 'closed' WHERE id = ?", [night.id]);
  respond(res, night.id, req.userId);
});

// Leave. The host leaving ends it for everyone.
router.delete("/:id/members/me", validate(idParam, "params"), (req, res) => {
  const night = loadNight(req.params.id);
  if (night.host_id === req.userId) {
    run("DELETE FROM movie_nights WHERE id = ?", [night.id]);
  } else {
    run("DELETE FROM movie_night_members WHERE night_id = ? AND user_id = ?", [
      night.id,
      req.userId,
    ]);
  }
  res.status(204).end();
});

// Housekeeping (server.js): rooms a day past their end are deleted.
export const pruneMovieNights = (now = Date.now()) =>
  Number(run("DELETE FROM movie_nights WHERE expires_at < ?", [now - 24 * 3600 * 1000]).changes);

export default router;
