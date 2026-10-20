import { Router } from "express";

import { getRankRarity } from "../lib/ranks.js";

// Mounted at /api/ranks.
const router = Router();

// GET /api/ranks/rarity — how rare each rank is: { watchers, rarity:
// { "saga-potterhead:3": 6, "time-traveler:1": 41, … } }, the share of
// watchers who have it, in whole percent. Ranks nobody has are left out.
router.get("/rarity", (req, res) => {
  res.set("Cache-Control", "private, max-age=300");
  res.json(getRankRarity());
});

export default router;
