import { Router } from "express";
import { all, fromJSON, get, run } from "../db/index.js";
import { getMovieById } from "../lib/movies.js";
import { languageOf, notificationText } from "../lib/push.js";
import { getUserRow, isBlocked, toPublicUser } from "../lib/users.js";

// Mounted at /api/me/notifications — what the server has told you (lib/push
// keeps each one it sends), newest first, for the app's Notifications page:
//   GET /        { notifications: [{ id, kind, title, body, url, createdAt,
//                  read, from: a person or null, movie: { id, title,
//                  poster } or null }], unread }
//   POST /read   everything up to now is seen.
// In your language now, whatever it was when it was sent; nothing from
// someone you've blocked (or who blocked you).
const router = Router();

const SHOWN = 50;

router.get("/", (req, res) => {
  const language = languageOf(req.userId);
  const rows = all(
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    [req.userId, SHOWN],
  ).filter((row) => !row.from_user_id || !isBlocked(req.userId, row.from_user_id));
  const notifications = rows.map((row) => {
    const [title, body] = notificationText(row.kind, fromJSON(row.args) ?? [], language);
    const from = row.from_user_id ? getUserRow(row.from_user_id) : null;
    const movie = row.movie_id ? getMovieById(row.movie_id) : null;
    return {
      id: row.id,
      kind: row.kind,
      title,
      body,
      url: row.url,
      createdAt: row.created_at,
      read: row.read_at != null,
      from: from ? toPublicUser(from) : null,
      movie: movie ? { id: movie.id, title: movie.title, poster: movie.poster } : null,
    };
  });
  const unread = get(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
    [req.userId],
  ).n;
  res.json({ notifications, unread });
});

router.post("/read", (req, res) => {
  run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [Date.now(), req.userId]);
  res.status(204).end();
});

export default router;
