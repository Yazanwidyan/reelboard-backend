import { all, fromJSON, get, run, toJSON } from "../db/index.js";
import { newId } from "./ids.js";
import { getMovieById } from "./movies.js";
import { toPublicUser } from "./users.js";

// Re-tiering or re-adding the same movie within this window updates the
// earlier event instead of stacking a new one, so fiddling with a tier
// doesn't flood friends' feeds.
const COALESCE_MS = 60 * 60 * 1000;

export const logActivity = (userId, type, { movieId = null, ...data } = {}) => {
  const now = Date.now();
  if (movieId) {
    const recent = get(
      `SELECT id FROM activity
       WHERE user_id = ? AND type = ? AND movie_id = ? AND created_at > ?`,
      [userId, type, movieId, now - COALESCE_MS],
    );
    if (recent) {
      run("UPDATE activity SET data = ?, created_at = ? WHERE id = ?", [
        toJSON(data),
        now,
        recent.id,
      ]);
      return;
    }
  }
  run(
    `INSERT INTO activity (id, user_id, type, movie_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId("a"), userId, type, movieId, toJSON(data), now],
  );
};

// Takes back a just-made event (e.g. un-marking a movie as watched, or
// taking it straight back off the watchlist).
export const retractActivity = (userId, type, movieId) => {
  run(
    "DELETE FROM activity WHERE user_id = ? AND type = ? AND movie_id = ? AND created_at > ?",
    [userId, type, movieId, Date.now() - COALESCE_MS],
  );
};

// Same shape as the app's getMockActivity() entries:
// { id, friendId, type, movieId, title?, tier?, badge?, set?, count?, timestamp, friend }
const toEvent = (row) => ({
  id: row.id,
  friendId: row.user_id,
  type: row.type,
  movieId: row.movie_id,
  ...(row.movie_id ? { title: getMovieById(row.movie_id)?.title ?? null } : {}),
  ...fromJSON(row.data, {}),
  timestamp: row.created_at,
  friend: toPublicUser({ ...row, id: row.user_id }),
});

// Newest first; pass the last event's timestamp as `before` for the next page.
// `movieIds` limits it to events about those movies (a club's feed).
export const listActivity = (userIds, { before, limit, movieIds }) => {
  if (userIds.length === 0 || movieIds?.length === 0) return [];
  const list = (ids) => ids.map(() => "?").join(", ");
  const movieFilter = movieIds ? `AND activity.movie_id IN (${list(movieIds)})` : "";
  return all(
    `SELECT activity.*, users.display_name, users.handle, users.color, users.level,
            users.avatar_uri, users.bio
     FROM activity JOIN users ON users.id = activity.user_id
     WHERE activity.user_id IN (${list(userIds)}) ${movieFilter} AND activity.created_at < ?
     ORDER BY activity.created_at DESC
     LIMIT ?`,
    [...userIds, ...(movieIds ?? []), before ?? Number.MAX_SAFE_INTEGER, limit],
  ).map(toEvent);
};

// ---- Cleanup ---------------------------------------------------------------
//
// The feed only ever shows recent events, so old ones are deleted rather
// than kept forever: anything older than ACTIVITY_MAX_AGE_MS, and beyond
// each person's newest ACTIVITY_PER_USER. Runs on start-up and then every
// few hours (see server.js).

export const ACTIVITY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const ACTIVITY_PER_USER = 200;

export const pruneActivity = ({
  now = Date.now(),
  maxAgeMs = ACTIVITY_MAX_AGE_MS,
  perUser = ACTIVITY_PER_USER,
} = {}) => {
  const old = run("DELETE FROM activity WHERE created_at < ?", [now - maxAgeMs]).changes;
  const extra = run(
    `DELETE FROM activity WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS position
         FROM activity
       ) WHERE position > ?
     )`,
    [perUser],
  ).changes;
  return Number(old) + Number(extra);
};
