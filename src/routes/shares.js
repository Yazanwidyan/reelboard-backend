import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import config from "../config.js";
import { get, run } from "../db/index.js";
import { getCollection } from "../lib/collections.js";
import { notFound } from "../lib/errors.js";
import { getMovieById } from "../lib/movies.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/shares — links to ReelBoard pages anyone can open in a
// browser (routes/web.js), for sharing outside the app:
//
//   movie, collection   public already: /m/:id, /c/:id
//   profile, list       yours, so private until you share them: a link
//                       with its own random token (/s/:token), made the
//                       first time you share and the same after. Taking it
//                       back (DELETE) stops it working.
const router = Router();

const newToken = () => crypto.randomBytes(9).toString("base64url");
export const webUrl = (pathname) => `${config.publicUrl.replace(/\/$/, "")}${pathname}`;

// POST /api/shares — { type, id } (no id for your profile) → { url }.
router.post(
  "/",
  validate(
    z.object({
      type: z.enum(["movie", "collection", "list", "profile"]),
      id: z.string().min(1).max(64).optional(),
    }),
  ),
  (req, res) => {
    const { type, id } = req.body;
    if (type === "movie") {
      if (!id || !getMovieById(id)) throw notFound("No such movie");
      return res.json({ url: webUrl(`/m/${id}`) });
    }
    if (type === "collection") {
      if (!id || !getCollection(id)) throw notFound("No such collection");
      return res.json({ url: webUrl(`/c/${encodeURIComponent(id)}`) });
    }
    const targetId = type === "profile" ? req.userId : id;
    if (type === "list" && !get("SELECT 1 FROM boards WHERE id = ? AND user_id = ?", [targetId ?? "", req.userId])) {
      throw notFound("No such list");
    }
    const existing = get(
      "SELECT token FROM share_links WHERE user_id = ? AND type = ? AND target_id = ? AND revoked_at IS NULL",
      [req.userId, type, targetId],
    );
    const token = existing?.token ?? newToken();
    if (!existing) {
      run("INSERT INTO share_links (token, user_id, type, target_id, created_at) VALUES (?, ?, ?, ?, ?)", [
        token,
        req.userId,
        type,
        targetId,
        Date.now(),
      ]);
    }
    res.json({ url: webUrl(`/s/${token}`), token });
  },
);

// DELETE /api/shares/:token — stop a link of yours working.
router.delete("/:token", validate(z.object({ token: z.string().min(1).max(64) }), "params"), (req, res) => {
  run("UPDATE share_links SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL", [
    Date.now(),
    req.params.token,
    req.userId,
  ]);
  res.status(204).end();
});

export default router;
