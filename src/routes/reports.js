import { Router } from "express";
import { z } from "zod";
import { get, run } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { areFriends, getUserRow, isSuspended } from "../lib/users.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/reports — reporting a person, one of their lists, or a
// club, for an admin to look at (the admin site's Reports queue). You can
// only report what you can see: anyone you can find, a friend's list, a
// club you're in (not your own things).
const router = Router();

export const REPORT_REASONS = ["spam", "offensive", "harassment", "impersonation", "other"];
const NOTE_MAX = 500;

// What's being reported, as the queue keeps it: { label, ownerId }.
const findTarget = (type, id, me) => {
  if (type === "user") {
    const row = getUserRow(id);
    if (!row || isSuspended(row)) throw notFound("No such user");
    if (row.id === me) throw badRequest("You can't report yourself");
    return { label: `${row.display_name} (@${row.handle})`, ownerId: row.id };
  }
  if (type === "list") {
    const board = get("SELECT id, name, user_id FROM boards WHERE id = ?", [id]);
    if (!board || (board.user_id !== me && !areFriends(me, board.user_id))) throw notFound("No such list");
    if (board.user_id === me) throw badRequest("That's your own list");
    return { label: board.name, ownerId: board.user_id };
  }
  const club = get("SELECT id, name, owner_id FROM clubs WHERE id = ?", [id]);
  const member = club && get("SELECT 1 FROM club_members WHERE club_id = ? AND user_id = ?", [club.id, me]);
  if (!member) throw notFound("No such club");
  if (club.owner_id === me) throw badRequest("That's your own club");
  return { label: club.name, ownerId: club.owner_id };
};

// POST /api/reports — { targetType, targetId, reason, note }. Reporting the
// same thing again while it's still open adds nothing (and says so).
router.post(
  "/",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }),
  validate(
    z.object({
      targetType: z.enum(["user", "list", "club"]),
      targetId: z.string().min(1).max(64),
      reason: z.enum(REPORT_REASONS),
      note: z.string().trim().max(NOTE_MAX).default(""),
    }),
  ),
  (req, res) => {
    const { targetType, targetId, reason, note } = req.body;
    const target = findTarget(targetType, targetId, req.userId);
    const open = get(
      "SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'",
      [req.userId, targetType, targetId],
    );
    if (open) return res.json({ report: { id: open.id }, alreadyReported: true });
    const id = newId("r");
    run(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, owner_id, target_label, reason, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.userId, targetType, targetId, target.ownerId, target.label, reason, note, Date.now()],
    );
    res.status(201).json({ report: { id }, alreadyReported: false });
  },
);

export default router;
