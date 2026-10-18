import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const config = {
  root,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  // ":memory:" works too — handy for tests.
  databasePath: process.env.DATABASE_PATH ?? path.join(root, "data", "reelboard.db"),
  // What people chose by hand (the pool itself is in the database).
  curationPath: path.join(root, "data", "curation.json"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  // Comma-separated list, or "*" for any origin (the default; a native app
  // doesn't send an Origin header anyway, this only matters for web).
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // Social sign-in: the client ids a Google / Apple sign-in token must have
  // been issued to. Google's are the OAuth client ids from Google Cloud
  // (the web client id the app passes to Google Sign-In); Apple's is the
  // app's bundle id ("host.exp.Exponent" when testing in Expo Go).
  googleClientIds: list(process.env.GOOGLE_CLIENT_IDS),
  appleClientIds: list(process.env.APPLE_CLIENT_IDS ?? "com.yazanwidyan.reelboard"),
};

export default config;
