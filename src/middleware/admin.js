import config from "../config.js";
import { forbidden } from "../lib/errors.js";
import { getUserRow } from "../lib/users.js";

// After requireAuth: lets through only accounts whose email is in
// ADMIN_EMAILS (config.adminEmails). The admin site signs in with a normal
// ReelBoard account; this is what makes it an admin one.
export const isAdmin = (userId) => {
  const email = getUserRow(userId)?.email?.toLowerCase();
  return Boolean(email) && config.adminEmails.includes(email);
};

export const requireAdmin = (req, res, next) =>
  isAdmin(req.userId) ? next() : next(forbidden("Admins only"));

export default requireAdmin;
