import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

export const config = {
  root,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  // ":memory:" works too — handy for tests.
  databasePath: process.env.DATABASE_PATH ?? path.join(root, "data", "reelboard.db"),
  catalogPath: path.join(root, "data", "catalog.json"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  // Comma-separated list, or "*" for any origin (the default; a native app
  // doesn't send an Origin header anyway, this only matters for web).
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};

export default config;
