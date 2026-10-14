import { get, run } from "../db/index.js";
import { badRequest, conflict } from "../lib/errors.js";

// Makes a change safe to send twice. The app puts a random
// "Idempotency-Key" on every change it queues; if the same key comes back
// (the reply was lost, or the app replayed its offline queue after a
// restart), the saved response is sent again and the change isn't applied
// a second time — so a rewatch or a pass never counts twice.
//
// Runs after requireAuth (keys are per user). Only successful responses are
// kept: a rejected change can simply be tried again.

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const idempotency = (req, res, next) => {
  const key = req.get("idempotency-key");
  // /api/me has two routers in a row — only the first pass counts.
  if (!key || req.method === "GET" || req.method === "HEAD" || req.idempotent) return next();
  req.idempotent = true;
  if (!KEY_FORMAT.test(key)) return next(badRequest("Invalid Idempotency-Key"));

  const saved = get("SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?", [
    req.userId,
    key,
  ]);
  if (saved) {
    if (saved.method !== req.method || saved.path !== req.originalUrl) {
      return next(conflict("Idempotency-Key was already used for a different request"));
    }
    res.set("Idempotent-Replayed", "true");
    res.status(saved.status);
    return saved.body == null ? res.end() : res.json(JSON.parse(saved.body));
  }

  let body = null;
  const json = res.json.bind(res);
  res.json = (value) => {
    body = value;
    return json(value);
  };
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const now = Date.now();
    try {
      run(
        `INSERT OR IGNORE INTO idempotency_keys (user_id, key, method, path, status, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.userId, key, req.method, req.originalUrl, res.statusCode, body == null ? null : JSON.stringify(body), now],
      );
      run("DELETE FROM idempotency_keys WHERE created_at < ?", [now - MAX_AGE_MS]);
    } catch {
      // The account was just deleted (DELETE /api/me) — nothing to keep.
    }
  });
  next();
};

export default idempotency;
