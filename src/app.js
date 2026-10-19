import fs from "node:fs";
import path from "node:path";
import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import config from "./config.js";
import { requireAdmin } from "./middleware/admin.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { idempotency } from "./middleware/idempotency.js";
import activityRoutes from "./routes/activity.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import boardRoutes from "./routes/boards.js";
import challengeRoutes from "./routes/challenges.js";
import clubRoutes from "./routes/clubs.js";
import collectionRoutes from "./routes/collections.js";
import communityRoutes from "./routes/community.js";
import { friendsRouter, usersRouter } from "./routes/friends.js";
import libraryRoutes from "./routes/library.js";
import meRoutes from "./routes/me.js";
import movieNightRoutes from "./routes/movieNights.js";
import movieRoutes from "./routes/movies.js";
import peopleRoutes from "./routes/people.js";
import pushRoutes from "./routes/push.js";
import tasteRoutes from "./routes/taste.js";

// Builds the Express app. The database must already be open (see server.js).
export const createApp = () => {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // The admin site shows TMDB's posters and photos.
          "img-src": ["'self'", "data:", "https://image.tmdb.org", "https://img.youtube.com"],
        },
      },
    }),
  );
  // Responses carry movies (candidates are a few hundred KB of JSON); gzipped
  // they're a fraction of that.
  app.use(compression());
  app.use(
    cors({
      origin: config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",").map((o) => o.trim()),
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "If-None-Match"],
      exposedHeaders: ["ETag", "Idempotent-Replayed"],
    }),
  );
  // The import endpoint carries a whole local library, so allow a roomy body.
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Public
  app.use("/api/auth", authRoutes);
  app.use("/api/movies", movieRoutes);

  // Signed in. Changes may carry an Idempotency-Key (see middleware/idempotency.js).
  const signedIn = [requireAuth, idempotency];
  app.use("/api/me/challenges", signedIn, challengeRoutes);
  app.use("/api/me/taste", signedIn, tasteRoutes);
  app.use("/api/me/push-tokens", signedIn, pushRoutes);
  app.use("/api/me", signedIn, libraryRoutes);
  app.use("/api/me", signedIn, meRoutes);
  app.use("/api/boards", signedIn, boardRoutes);
  app.use("/api/users", signedIn, usersRouter);
  app.use("/api/friends", signedIn, friendsRouter);
  app.use("/api/activity", signedIn, activityRoutes);
  app.use("/api/community", signedIn, communityRoutes);
  app.use("/api/clubs", signedIn, clubRoutes);
  app.use("/api/collections", signedIn, collectionRoutes);
  app.use("/api/people", signedIn, peopleRoutes);
  app.use("/api/movie-nights", signedIn, movieNightRoutes);

  // Admins only (ADMIN_EMAILS) — the admin site's API.
  app.use("/api/admin", requireAuth, requireAdmin, adminRoutes);

  // The admin site itself (../Reelboard-admin, built), at /admin. Its pages
  // are all index.html; the app routes them.
  if (fs.existsSync(path.join(config.adminDist, "index.html"))) {
    app.use("/admin", express.static(config.adminDist, { index: false, maxAge: "1h" }));
    app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(path.join(config.adminDist, "index.html")));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

export default createApp;
