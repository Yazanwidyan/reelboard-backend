import { Router } from "express";
import { z } from "zod";
import { run } from "../db/index.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/events — the few things the app reports so the admin
// dashboard can show the launch numbers: how far people get through
// onboarding (each step, finished or skipped), whether they let it send
// reminders, share their Taste DNA, and come back a week later.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
export const EVENTS = [
  "app_open",
  "onboarding_seen",
  "onboarding_dna",
  "onboarding_pick",
  "onboarding_completed",
  "onboarding_skipped",
  "notifications_allowed",
  "dna_shared",
  // The taste metric: a pick for tonight taken, then watched.
  "pick_accepted",
  "pick_watched",
  // Onboarding's pick saved for later instead ("Not tonight").
  "pick_later",
  // The morning question: watched it or not — and the activation, a tier
  // for the film it asked about.
  "nudge_watched",
  "nudge_not_watched",
  "pick_tiered",
];
export const DEVICE_EVENTS = ["welcome_viewed", "signin_tapped", "signed_in"];

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

// Mounted at /api/device-events, with no sign-in: what happens before an
// account exists, by a random id the phone made for itself.
export const deviceRouter = Router();
deviceRouter.post(
  "/",
  validate(z.object({ deviceId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), name: z.enum(DEVICE_EVENTS) })),
  (req, res) => {
    const now = Date.now();
    run("INSERT OR IGNORE INTO device_events (device_id, name, day, created_at) VALUES (?, ?, ?, ?)", [
      req.body.deviceId,
      req.body.name,
      Math.floor(now / DAY),
      now,
    ]);
    res.status(204).end();
  },
);

export default router;
