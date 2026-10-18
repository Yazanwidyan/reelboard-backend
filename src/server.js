import { createApp } from "./app.js";
import config from "./config.js";
import { closeDatabase, openDatabase, poolSize } from "./db/index.js";
import { pruneActivity } from "./lib/activity.js";
import { updateAllLevels } from "./lib/xp.js";
import { pruneMovieNights } from "./routes/movieNights.js";

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

openDatabase();

// The movies are in the database, filled from TMDB by `npm run build-pool`.
const movies = poolSize();
if (movies === 0) {
  console.warn(
    "No movies in the database yet — run `npm run build-pool` (a few minutes, needs TMDB_READ_TOKEN), then restart.",
  );
} else {
  console.log(`${movies} movies in the pool`);
}

// XP and level are worked out here, not by the app — refresh everyone's on
// start, so older app-reported values (or a changed pool) are corrected.
const users = updateAllLevels();
console.log(`Levels checked for ${users} account(s)`);

// Housekeeping, now and every few hours: old friends-feed events and
// finished movie nights.
const maintain = () => {
  try {
    const removed = pruneActivity();
    if (removed > 0) console.log(`Activity cleanup: removed ${removed} old event(s)`);
    const nights = pruneMovieNights();
    if (nights > 0) console.log(`Removed ${nights} finished movie night(s)`);
  } catch (error) {
    console.error("Cleanup failed", error);
  }
};
maintain();
const maintenanceTimer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

const server = createApp().listen(config.port, () => {
  console.log(`ReelBoard API listening on http://localhost:${config.port}/api`);
});

const shutdown = () => {
  clearInterval(maintenanceTimer);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
