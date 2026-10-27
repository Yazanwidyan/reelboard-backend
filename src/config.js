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
  // What people chose by hand (the pool itself is in the database). The
  // admin site writes it; tests point it at a copy.
  curationPath: process.env.CURATION_PATH ?? path.join(root, "data", "curation.json"),
  // Who can use the admin site: these accounts' emails, comma-separated.
  adminEmails: list(process.env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  // The admin site's built files (../Reelboard-admin, `npm run build`).
  adminDist: process.env.ADMIN_DIST ?? path.join(root, "..", "Reelboard-admin", "dist"),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  // Comma-separated list, or "*" for any origin (the default; a native app
  // doesn't send an Origin header anyway, this only matters for web).
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // Where people reach this server from outside — the start of every
  // share link (routes/shares.js), e.g. https://reelboard.app.
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  // Social sign-in: the client ids a Google / Apple sign-in token must have
  // been issued to. Google's are the OAuth client ids from Google Cloud
  // (the web client id the app passes to Google Sign-In); Apple's is the
  // app's bundle id ("host.exp.Exponent" when testing in Expo Go).
  googleClientIds: list(process.env.GOOGLE_CLIENT_IDS),
  appleClientIds: list(process.env.APPLE_CLIENT_IDS ?? "com.yazanwidyan.reelboard"),
};

export default config;
