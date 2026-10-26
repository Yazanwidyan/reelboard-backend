import jwt from "jsonwebtoken";
import config from "../config.js";
import { get } from "../db/index.js";
import { unauthorized } from "../lib/errors.js";
import { SUSPENDED_MESSAGE } from "../lib/users.js";

export const signToken = (userId) =>
  jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

// Requires "Authorization: Bearer <token>" and sets req.userId.
export const requireAuth = (req, res, next) => {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized("Session expired or invalid — sign in again"));
  }
  // A token can outlive its account — or its account can be suspended.
  const user = get("SELECT suspended_at FROM users WHERE id = ?", [payload.sub]);
  if (!user) return next(unauthorized("Account no longer exists"));
  if (user.suspended_at != null) return next(unauthorized(SUSPENDED_MESSAGE));
  req.userId = payload.sub;
  next();
};

export default requireAuth;
