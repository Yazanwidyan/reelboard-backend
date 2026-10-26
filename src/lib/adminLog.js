import { all, get, run } from "../db/index.js";
import { newId } from "./ids.js";
import { getUserRow } from "./users.js";

// The admin log: one line for everything an admin changes on the admin site
// — who, what, to what, when. Written by routes/admin.js after each change;
// read by its Log page.
//
// `action` is a short key ("user.suspend", "saga.update"…), `target` what
// it was done to ({ type, id }), `summary` the line people read
// ("Suspended @sam — spam lists").
export const logAdmin = (adminId, action, target, summary) => {
  run(
    `INSERT INTO admin_log (id, admin_id, admin_email, action, target_type, target_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("l"),
      adminId,
      getUserRow(adminId)?.email ?? "unknown",
      action,
      target?.type ?? null,
      target?.id ?? null,
      summary,
      Date.now(),
    ],
  );
};

// Newest first: { entries, total }. `action` narrows to one kind ("user"
// matches every "user.…" action).
export const listAdminLog = ({ action, limit, offset }) => {
  const where = action ? "WHERE action = :action OR action LIKE :prefix" : "";
  const params = action ? { action, prefix: `${action}.%` } : {};
  const entries = all(
    `SELECT * FROM admin_log ${where} ORDER BY created_at DESC, rowid DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  ).map((row) => ({
    id: row.id,
    admin: { id: row.admin_id, email: row.admin_email },
    action: row.action,
    target: row.target_type ? { type: row.target_type, id: row.target_id } : null,
    summary: row.summary,
    createdAt: row.created_at,
  }));
  const total = get(`SELECT COUNT(*) AS n FROM admin_log ${where}`, params).n;
  return { entries, total };
};
