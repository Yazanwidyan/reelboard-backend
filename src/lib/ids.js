import crypto from "node:crypto";

// Short, prefixed, URL-safe ids: "u_…" users, "b_…" boards, "a_…" activity.
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
