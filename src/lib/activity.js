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
export const listActivity = (userIds, { before, limit }) => {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(", ");
  return all(
    `SELECT activity.*, users.display_name, users.handle, users.color, users.level,
            users.avatar_uri, users.bio
     FROM activity JOIN users ON users.id = activity.user_id
     WHERE activity.user_id IN (${placeholders}) AND activity.created_at < ?
     ORDER BY activity.created_at DESC
     LIMIT ?`,
    [...userIds, before ?? Number.MAX_SAFE_INTEGER, limit],
  ).map(toEvent);
};
