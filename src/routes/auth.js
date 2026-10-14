import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { get, run, toJSON, transaction } from "../db/index.js";
import { conflict, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { DEFAULT_PREFERENCES, handle } from "../lib/schemas.js";
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

router.post("/register", validate(registerSchema), async (req, res) => {
  const { email: emailAddress, password: plain, displayName, handle: wanted } = req.body;
  if (get("SELECT 1 FROM users WHERE email = ?", [emailAddress])) {
    throw conflict("An account with this email already exists");
  }
  const passwordHash = await bcrypt.hash(plain, 10);
  const id = newId("u");
  transaction(() => {
    run(
      `INSERT INTO users (id, email, password_hash, handle, display_name, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        emailAddress,
        passwordHash,
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
  res.status(201).json(session(id));
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const user = get("SELECT id, password_hash FROM users WHERE email = ?", [req.body.email]);
  const ok = await bcrypt.compare(req.body.password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Wrong email or password");
  res.json(session(user.id));
});

// Swap a still-valid token for a fresh one (keeps long-lived app sessions alive).
router.post("/refresh", requireAuth, (req, res) => {
  res.json(session(req.userId));
});

export default router;
