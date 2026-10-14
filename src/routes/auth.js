import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { get, run, toJSON, transaction } from "../db/index.js";
import { conflict, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { DEFAULT_PREFERENCES, handle } from "../lib/schemas.js";
import { verifiers } from "../lib/social.js";
import { getUserRow, pickColor, toProfile } from "../lib/users.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(8, "At least 8 characters").max(200);

const registerSchema = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(50),
  handle: handle.optional(),
});

const loginSchema = z.object({ email, password: z.string().min(1) });

// "Sam.Rivera+films@x.com" → "sam.rivera", then sam.rivera2, sam.rivera3…
// until one is free.
const availableHandle = (wanted, emailAddress) => {
  const base =
    (wanted ?? emailAddress.split("@")[0].replace(/[^a-zA-Z0-9_.]/g, ""))
      .slice(0, 17)
      .padEnd(3, "_");
  const taken = (candidate) => get("SELECT 1 FROM users WHERE handle = ?", [candidate]);
  if (!taken(base)) return base;
  if (wanted) throw conflict(`@${wanted} is taken`);
  for (let n = 2; ; n += 1) {
    if (!taken(`${base}${n}`)) return `${base}${n}`;
  }
};

// Compared against when the email is unknown, so a login takes the same time
// either way and doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync("reelboard-dummy-password", 10);

const session = (userId) => ({ token: signToken(userId), user: toProfile(getUserRow(userId)) });

// Inserts a new account and its settings row; returns its id. Runs inside
// the caller's transaction when there is one.
const createUser = ({ emailAddress, passwordHash, hasPassword = true, displayName, wanted }) => {
  const id = newId("u");
  transaction(() => {
    run(
      `INSERT INTO users (id, email, password_hash, has_password, handle, display_name, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        emailAddress,
        passwordHash,
        hasPassword ? 1 : 0,
        availableHandle(wanted, emailAddress),
        displayName,
        pickColor(id),
        Date.now(),
      ],
    );
    run("INSERT INTO user_state (user_id, preferences) VALUES (?, ?)", [
      id,
      toJSON(DEFAULT_PREFERENCES),
    ]);
  });
  return id;
};

router.post("/register", validate(registerSchema), async (req, res) => {
  const { email: emailAddress, password: plain, displayName, handle: wanted } = req.body;
  if (get("SELECT 1 FROM users WHERE email = ?", [emailAddress])) {
    throw conflict("An account with this email already exists");
  }
  const passwordHash = await bcrypt.hash(plain, 10);
  const id = createUser({ emailAddress, passwordHash, displayName, wanted });
  res.status(201).json(session(id));
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const user = get("SELECT id, password_hash, has_password FROM users WHERE email = ?", [
    req.body.email,
  ]);
  const ok = await bcrypt.compare(req.body.password, user?.password_hash ?? DUMMY_HASH);
  if (user && !user.has_password) {
    throw unauthorized("This account signs in with Google or Apple — use that button instead");
  }
  if (!user || !ok) throw unauthorized("Wrong email or password");
  res.json(session(user.id));
});

// ---- Google / Apple ------------------------------------------------------
//
// The app signs in with the provider's own sheet and sends the token it got
// back. The first time, this finds the account with the same (verified)
// email and links it, or creates a new one; after that the provider's user
// id alone finds it. Responds like login, plus `isNew` for a new account.

const signInWithProvider = async (provider, token, givenName) => {
  const who = await verifiers[provider](token);
  const linked = get("SELECT user_id FROM auth_identities WHERE provider = ? AND subject = ?", [
    provider,
    who.subject,
  ]);
  if (linked) return { userId: linked.user_id, isNew: false };

  const emailAddress = who.email?.toLowerCase() ?? null;
  const existing = emailAddress
    ? get("SELECT id FROM users WHERE email = ?", [emailAddress])
    : null;
  // Only a provider-verified email may be linked to an existing account —
  // otherwise anyone could claim an account by typing its email elsewhere.
  if (existing && !who.emailVerified) {
    throw conflict("An account with this email already exists — sign in with email");
  }

  const passwordHash = existing ? null : await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  return transaction(() => {
    const userId =
      existing?.id ??
      createUser({
        // Apple can withhold the email entirely; the account still needs one.
        emailAddress: emailAddress ?? `${provider}-${who.subject}@users.reelboard.invalid`,
        passwordHash,
        hasPassword: false,
        displayName: (who.name ?? givenName ?? emailAddress?.split("@")[0] ?? "Movie fan").slice(0, 50),
      });
    run(
      `INSERT INTO auth_identities (provider, subject, user_id, email, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [provider, who.subject, userId, emailAddress, Date.now()],
    );
    return { userId, isNew: !existing };
  });
};

router.post(
  "/google",
  validate(z.object({ idToken: z.string().min(1).max(5000) })),
  async (req, res) => {
    const { userId, isNew } = await signInWithProvider("google", req.body.idToken);
    res.status(isNew ? 201 : 200).json({ ...session(userId), isNew });
  },
);

router.post(
  "/apple",
  validate(
    z.object({
      identityToken: z.string().min(1).max(5000),
      // Apple only gives the app the user's name on the first sign-in.
      fullName: z.string().trim().min(1).max(50).optional(),
    }),
  ),
  async (req, res) => {
    const { userId, isNew } = await signInWithProvider(
      "apple",
      req.body.identityToken,
      req.body.fullName,
    );
    res.status(isNew ? 201 : 200).json({ ...session(userId), isNew });
  },
);

// Swap a still-valid token for a fresh one (keeps long-lived app sessions alive).
router.post("/refresh", requireAuth, (req, res) => {
  res.json(session(req.userId));
});

export default router;
