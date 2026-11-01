import { Router } from "express";
import { z } from "zod";
import { run } from "../db/index.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/events — the few things the app reports so the admin
// dashboard can show the launch numbers: did people finish onboarding,
// share their Taste DNA, and come back a week later.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
export const EVENTS = ["app_open", "onboarding_completed", "dna_shared"];

// Once per person, event and day is all that's kept.
router.post("/", validate(z.object({ name: z.enum(EVENTS) })), (req, res) => {
  const now = Date.now();
  run("INSERT OR IGNORE INTO events (user_id, name, day, created_at) VALUES (?, ?, ?, ?)", [
    req.userId,
    req.body.name,
    Math.floor(now / DAY),
    now,
  ]);
  res.status(204).end();
});

export default router;
