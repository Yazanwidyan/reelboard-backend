import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import config from "./config.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import activityRoutes from "./routes/activity.js";
import authRoutes from "./routes/auth.js";
import boardRoutes from "./routes/boards.js";
import challengeRoutes from "./routes/challenges.js";
import { friendsRouter, usersRouter } from "./routes/friends.js";
import libraryRoutes from "./routes/library.js";
import meRoutes from "./routes/me.js";
import movieRoutes from "./routes/movies.js";
import tasteRoutes from "./routes/taste.js";

// Builds the Express app. The database must already be open (see server.js).
export const createApp = () => {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  // The catalog is ~340 KB of JSON; gzipped it's a fraction of that.
  app.use(compression());
  app.use(
    cors({
      origin: config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",").map((o) => o.trim()),
    }),
  );
  // The import endpoint carries a whole local library, so allow a roomy body.
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Public
  app.use("/api/auth", authRoutes);
  app.use("/api/movies", movieRoutes);

  // Signed in
  app.use("/api/me/challenges", requireAuth, challengeRoutes);
  app.use("/api/me/taste", requireAuth, tasteRoutes);
  app.use("/api/me", requireAuth, libraryRoutes);
  app.use("/api/me", requireAuth, meRoutes);
  app.use("/api/boards", requireAuth, boardRoutes);
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/friends", requireAuth, friendsRouter);
  app.use("/api/activity", requireAuth, activityRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

export default createApp;
