import { Router } from "express";
import { z } from "zod";
import { listActivity, logActivity } from "../lib/activity.js";
import { moviesOutsidePool } from "../lib/movies.js";
import { friendIdsOf } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/activity — the friends feed (replaces getMockActivity()).
// watched / tier / watchlist events are recorded automatically by the
// library routes; badge and set events are posted by the app, since badges
// and collections are worked out on the device.
const router = Router();

const feedQuery = z.object({
  // Pass the last event's timestamp to get the next page.
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  includeMine: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

router.get("/", validate(feedQuery, "query"), (req, res) => {
  const { before, limit, includeMine } = req.validQuery;
  const userIds = friendIdsOf(req.userId);
  if (includeMine) userIds.push(req.userId);
  const activity = listActivity(userIds, { before, limit });
  res.json({ activity, movies: moviesOutsidePool(activity.map((event) => event.movieId)) });
});

router.get("/mine", validate(feedQuery, "query"), (req, res) => {
  const { before, limit } = req.validQuery;
  const activity = listActivity([req.userId], { before, limit });
  res.json({ activity, movies: moviesOutsidePool(activity.map((event) => event.movieId)) });
});

const achievementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("badge"), badge: z.string().trim().min(1).max(60) }),
  // Finished a collection: { set: "Martin Scorsese", count: 4 }
  z.object({
    type: z.literal("set"),
    set: z.string().trim().min(1).max(80),
    count: z.number().int().min(1).max(1000),
  }),
]);

router.post("/", validate(achievementSchema), (req, res) => {
  const { type, ...data } = req.body;
  logActivity(req.userId, type, data);
  res.status(201).json({ ok: true });
});

export default router;
