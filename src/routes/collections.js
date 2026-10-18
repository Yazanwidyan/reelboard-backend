import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { attachCollections, getCollection, getFeaturedCollections } from "../lib/collections.js";
import { notFound } from "../lib/errors.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/collections (signed in). Collections are worked out from
// the pool (lib/collections.js); the app gets yours with your library
// (GET /api/me/library) and these:
//   GET /             the featured ones, to browse and suggest from
//   GET /:id          one collection, with every film in it
const router = Router();

// The pool only changes when the server restarts, so the featured list is
// serialized and hashed once.
let featuredResponse = null;
const getFeaturedResponse = () => {
  if (!featuredResponse) {
    const body = JSON.stringify(attachCollections([], getFeaturedCollections()));
    const hash = crypto.createHash("sha256").update(body).digest("base64url").slice(0, 27);
    featuredResponse = { body, etag: `"${hash}"` };
  }
  return featuredResponse;
};

// GET /api/collections — the best-known franchises, directors and actors,
// and every decade and genre, with cards for the first few films of each.
// Sent with an ETag; send it back as If-None-Match for an empty 304 while
// nothing changed.
router.get("/", (req, res) => {
  const { body, etag } = getFeaturedResponse();
  res.set({ ETag: etag, "Cache-Control": "no-cache" });
  const known = (req.get("if-none-match") ?? "").split(",").map((tag) => tag.trim());
  if (known.includes(etag)) return res.status(304).end();
  res.type("json").send(body);
});

// GET /api/collections/:id — e.g. director-christopher-nolan.
router.get(
  "/:id",
  validate(z.object({ id: z.string().regex(/^[a-z]+-[a-z0-9-]{1,120}$/) }), "params"),
  (req, res) => {
    const collection = getCollection(req.params.id);
    if (!collection) throw notFound("No such collection");
    res.json({ collection, ...attachCollections([], [collection], { cardsPer: Infinity }) });
  },
);

export default router;
