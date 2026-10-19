import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all } from "../db/index.js";
import {
  attachCollections,
  collectionsVersion,
  getCollection,
  getFeaturedCollections,
} from "../lib/collections.js";
import { notFound } from "../lib/errors.js";
import { getMovieById } from "../lib/movies.js";
import { imageUrl, tmdbGet } from "../lib/tmdb.js";
import { friendIdsOf, getUserRow, toPublicUser } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/collections (signed in). Collections are worked out from
// the pool (lib/collections.js); the app gets yours with your library
// (GET /api/me/library) and these:
//   GET /             the featured ones, to browse and suggest from
//   GET /:id          one collection, with every film in it, its picture
//                     and your friends' progress through it
const router = Router();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Serialized and hashed once per version of the collections (they change
// when the server restarts, or the admin site edits a saga).
let featuredResponse = null;
const getFeaturedResponse = () => {
  if (featuredResponse?.version !== collectionsVersion()) {
    const body = JSON.stringify(attachCollections([], getFeaturedCollections()));
    const hash = crypto.createHash("sha256").update(body).digest("base64url").slice(0, 27);
    featuredResponse = { body, etag: `"${hash}"`, version: collectionsVersion() };
  }
  return featuredResponse;
};

// GET /api/collections — every saga, with cards for the first few films of
// each.
// Sent with an ETag; send it back as If-None-Match for an empty 304 while
// nothing changed.
router.get("/", (req, res) => {
  const { body, etag } = getFeaturedResponse();
  res.set({ ETag: etag, "Cache-Control": "no-cache" });
  const known = (req.get("if-none-match") ?? "").split(",").map((tag) => tag.trim());
  if (known.includes(etag)) return res.status(304).end();
  res.type("json").send(body);
});

// The collection's own picture, for its page: { photo } of the actor or
// director, { backdrop } of the franchise — or null (decades, genres, or
// nothing found). Cast photos come with the movies; a director's photo and
// a franchise's artwork are TMDB's, asked for once a week at most.
const artFor = async (collection) => {
  // A saga's artwork was picked when the pool was built.
  if (collection.art) return collection.art;
  const movies = collection.movieIds.map(getMovieById).filter(Boolean);
  try {
    if (collection.type === "actor") {
      for (const movie of movies) {
        const person = movie.details?.castDetails?.find((cast) => cast.name === collection.title);
        // The cast list's small photo, as a large one.
        if (person?.photo) return { photo: person.photo.replace("/w185/", "/h632/") };
      }
    }
    if (collection.type === "director") {
      const person = movies
        .flatMap((movie) => movie.details?.directors ?? [])
        .find((director) => director.name === collection.title && director.id);
      if (person) {
        const data = await tmdbGet(`/person/${person.id}`, { language: "en-US" }, { ttl: WEEK_MS });
        const photo = imageUrl(data?.profile_path, "h632");
        if (photo) return { photo };
      }
    }
    if (collection.type === "franchise") {
      const tmdbId = movies.map((movie) => movie.details?.collection?.id).find(Boolean);
      if (tmdbId) {
        const data = await tmdbGet(`/collection/${tmdbId}`, { language: "en-US" }, { ttl: WEEK_MS });
        const backdrop = imageUrl(data?.backdrop_path, "w1280");
        if (backdrop) return { backdrop };
      }
    }
  } catch {
    // TMDB can't be reached: the page shows its posters instead.
  }
  if (collection.type === "franchise") {
    const backdrop = movies.find((movie) => movie.backdrop)?.backdrop;
    if (backdrop) return { backdrop };
  }
  return null;
};

// Your friends who've watched any of it: { user, watchedCount, tiers:
// { movieId: tier | null } }, furthest along first.
const friendsFor = (userId, collection) => {
  const friendIds = friendIdsOf(userId);
  if (friendIds.length === 0 || collection.movieIds.length === 0) return [];
  const rows = all(
    `SELECT user_id, movie_id, tier FROM watched
     WHERE user_id IN (${friendIds.map(() => "?").join(",")})
       AND movie_id IN (${collection.movieIds.map(() => "?").join(",")})`,
    [...friendIds, ...collection.movieIds],
  );
  const byFriend = new Map();
  rows.forEach((row) => {
    if (!byFriend.has(row.user_id)) byFriend.set(row.user_id, {});
    byFriend.get(row.user_id)[row.movie_id] = row.tier ?? null;
  });
  return [...byFriend.entries()]
    .map(([friendId, tiers]) => ({
      user: toPublicUser(getUserRow(friendId)),
      watchedCount: Object.keys(tiers).length,
      tiers,
    }))
    .sort((a, b) => b.watchedCount - a.watchedCount || a.user.name.localeCompare(b.user.name));
};

// GET /api/collections/:id — e.g. director-christopher-nolan.
router.get(
  "/:id",
  validate(z.object({ id: z.string().regex(/^[a-z]+-[a-z0-9-]{1,120}$/) }), "params"),
  async (req, res) => {
    const collection = getCollection(req.params.id);
    if (!collection) throw notFound("No such collection");
    res.json({
      collection,
      ...attachCollections([], [collection], { cardsPer: Infinity }),
      art: await artFor(collection),
      friends: friendsFor(req.userId, collection),
    });
  },
);

export default router;
