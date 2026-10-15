import { Router } from "express";
import { z } from "zod";
import { run } from "../db/index.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/me/push-tokens — the phones this account gets push
// notifications on (see lib/push.js). A token moves to whoever registers it
// last, so a shared phone only notifies the person signed in.
const router = Router();

const token = z.string().trim().min(10).max(200);

router.post(
  "/",
  validate(z.object({ token, platform: z.enum(["ios", "android", "web"]).optional() })),
  (req, res) => {
    run(
      `INSERT INTO push_tokens (token, user_id, platform, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform`,
      [req.body.token, req.userId, req.body.platform ?? null, Date.now()],
    );
    res.status(204).end();
  },
);

// Signing out on a phone, or turning notifications off there.
router.delete("/", validate(z.object({ token })), (req, res) => {
  run("DELETE FROM push_tokens WHERE token = ? AND user_id = ?", [req.body.token, req.userId]);
  res.status(204).end();
});

export default router;
