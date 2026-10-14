import { Router } from "express";
import { z } from "zod";
import { all, fromJSON, get, run } from "../db/index.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { listBoards } from "../lib/library.js";
import { handle } from "../lib/schemas.js";
import { areFriends, friendIdsOf, getUserRow, toPublicUser } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Replaces the app's data/mockFriends.js. A friend comes back in the same
// shape as a mock friend — { id, name, handle, color, level, watched:
// [{ movieId, tier }] } — so utils/friends.js (taste match, "both loved",
// "they loved, you haven't") works on real data unchanged.

export const usersRouter = Router(); // /api/users
export const friendsRouter = Router(); // /api/friends

const getFriendship = (a, b) =>
  get(
    `SELECT * FROM friendships
     WHERE (requester_id = :a AND addressee_id = :b) OR (requester_id = :b AND addressee_id = :a)`,
    { a, b },
  );

// none | friends | outgoing (you asked) | incoming (they asked) | self
const relationship = (me, otherId) => {
  if (me === otherId) return "self";
  const friendship = getFriendship(me, otherId);
  if (!friendship) return "none";
  if (friendship.status === "accepted") return "friends";
  return friendship.requester_id === me ? "outgoing" : "incoming";
};

const tieredWatched = (userId) =>
  all(
    "SELECT movie_id, tier, watched_at FROM watched WHERE user_id = ? ORDER BY watched_at DESC",
    [userId],
  ).map((row) => ({ movieId: row.movie_id, tier: row.tier, timestamp: row.watched_at }));

const toFriend = (row) => ({
  ...toPublicUser(row),
  topTen: fromJSON(row.top_ten, []),
  watched: tieredWatched(row.id),
});

const userParam = z.object({ userId: z.string().min(1) });

const loadUser = (userId) => {
  const row = getUserRow(userId);
  if (!row) throw notFound("No such user");
  return row;
};

// ---- /api/users ----------------------------------------------------------

// Find people by handle or name.
usersRouter.get(
  "/search",
  validate(z.object({ q: z.string().trim().min(1).max(50) }), "query"),
  (req, res) => {
    const needle = req.validQuery.q.replace(/^@/, "").replace(/[%_\\]/g, "\\$&");
    const users = all(
      `SELECT * FROM users
       WHERE id <> :me AND (handle LIKE :prefix ESCAPE '\\' OR display_name LIKE :anywhere ESCAPE '\\')
       ORDER BY (handle LIKE :prefix ESCAPE '\\') DESC, display_name
       LIMIT 20`,
      { me: req.userId, prefix: `${needle}%`, anywhere: `%${needle}%` },
    ).map((row) => ({ ...toPublicUser(row), relationship: relationship(req.userId, row.id) }));
    res.json({ users });
  },
);

// Anyone's public card; friends (and you) also get their watch history.
usersRouter.get("/:userId", validate(userParam, "params"), (req, res) => {
  const row = loadUser(req.params.userId);
  const rel = relationship(req.userId, row.id);
  const user =
    rel === "friends" || rel === "self"
      ? { ...toFriend(row), boardCount: listBoards(row.id).length }
      : toPublicUser(row);
  res.json({ user: { ...user, relationship: rel } });
});

usersRouter.get("/:userId/boards", validate(userParam, "params"), (req, res) => {
  const row = loadUser(req.params.userId);
  if (row.id !== req.userId && !areFriends(req.userId, row.id)) {
    throw notFound("No such user");
  }
  res.json({ boards: listBoards(row.id) });
});

// ---- /api/friends --------------------------------------------------------

friendsRouter.get("/", (req, res) => {
  const friends = friendIdsOf(req.userId)
    .map(getUserRow)
    .map(toFriend)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ friends });
});

friendsRouter.get("/requests", (req, res) => {
  const pending = (column, otherColumn) =>
    all(
      `SELECT users.*, friendships.created_at AS requested_at
       FROM friendships JOIN users ON users.id = friendships.${otherColumn}
       WHERE friendships.${column} = ? AND friendships.status = 'pending'
       ORDER BY friendships.created_at DESC`,
      [req.userId],
    ).map((row) => ({ user: toPublicUser(row), requestedAt: row.requested_at }));
  res.json({
    incoming: pending("addressee_id", "requester_id"),
    outgoing: pending("requester_id", "addressee_id"),
  });
});

// Send a request by user id or @handle. If they already asked you, this
// accepts theirs instead.
friendsRouter.post(
  "/requests",
  validate(
    z
      .object({ userId: z.string().min(1).optional(), handle: handle.optional() })
      .refine((body) => body.userId || body.handle, "Give a userId or a handle"),
  ),
  (req, res) => {
    const target = req.body.userId
      ? getUserRow(req.body.userId)
      : get("SELECT * FROM users WHERE handle = ?", [req.body.handle]);
    if (!target) throw notFound("No such user");
    if (target.id === req.userId) throw badRequest("You can't friend yourself");

    const existing = getFriendship(req.userId, target.id);
    if (existing?.status === "accepted") throw conflict("You're already friends");
    if (existing && existing.requester_id === req.userId) throw conflict("Request already sent");

    if (existing) {
      run(
        `UPDATE friendships SET status = 'accepted', accepted_at = ?
         WHERE requester_id = ? AND addressee_id = ?`,
        [Date.now(), target.id, req.userId],
      );
      return res.json({ relationship: "friends", user: toFriend(target) });
    }
    run(
      `INSERT INTO friendships (requester_id, addressee_id, status, created_at)
       VALUES (?, ?, 'pending', ?)`,
      [req.userId, target.id, Date.now()],
    );
    res.status(201).json({ relationship: "outgoing", user: toPublicUser(target) });
  },
);

friendsRouter.post("/requests/:userId/accept", validate(userParam, "params"), (req, res) => {
  const { changes } = run(
    `UPDATE friendships SET status = 'accepted', accepted_at = ?
     WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`,
    [Date.now(), req.params.userId, req.userId],
  );
  if (!changes) throw notFound("No pending request from this user");
  res.json({ relationship: "friends", user: toFriend(getUserRow(req.params.userId)) });
});

// Decline a request to you, or cancel one you sent.
friendsRouter.delete("/requests/:userId", validate(userParam, "params"), (req, res) => {
  const { changes } = run(
    `DELETE FROM friendships WHERE status = 'pending'
       AND ((requester_id = :me AND addressee_id = :other)
         OR (requester_id = :other AND addressee_id = :me))`,
    { me: req.userId, other: req.params.userId },
  );
  if (!changes) throw notFound("No pending request with this user");
  res.status(204).end();
});

friendsRouter.delete("/:userId", validate(userParam, "params"), (req, res) => {
  const { changes } = run(
    `DELETE FROM friendships WHERE status = 'accepted'
       AND ((requester_id = :me AND addressee_id = :other)
         OR (requester_id = :other AND addressee_id = :me))`,
    { me: req.userId, other: req.params.userId },
  );
  if (!changes) throw notFound("You're not friends with this user");
  res.status(204).end();
});
