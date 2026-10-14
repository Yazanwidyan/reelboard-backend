import { all, fromJSON, get } from "../db/index.js";

// Avatar ring colors, the same family the app's mock friends use.
const COLORS = ["#8FD3F5", "#F8E08E", "#A4E59B", "#A9C4FF", "#F5B98F", "#F2A7C3", "#C9B6F2"];

export const pickColor = (seed) => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
};

// How other people see a user — same fields as the app's mock friends
// (name, "@handle", color, level), plus avatar and bio.
export const toPublicUser = (row) => ({
  id: row.id,
  name: row.display_name,
  handle: `@${row.handle}`,
  color: row.color,
  level: row.level,
  avatarUri: row.avatar_uri,
  bio: row.bio,
});

// How a user sees themself — the app's profileStore, plus account fields.
export const toProfile = (row) => ({
  id: row.id,
  email: row.email,
  // False for accounts made with Google / Apple (they have no password).
  hasPassword: row.has_password !== 0,
  displayName: row.display_name,
  handle: `@${row.handle}`,
  bio: row.bio,
  avatarUri: row.avatar_uri,
  color: row.color,
  xp: row.xp,
  level: row.level,
  topTen: fromJSON(row.top_ten, []),
  pinnedCollections: fromJSON(row.pinned_collections, []),
  createdAt: row.created_at,
});

export const getUserRow = (userId) => get("SELECT * FROM users WHERE id = ?", [userId]);

export const friendIdsOf = (userId) =>
  all(
    `SELECT CASE WHEN requester_id = :me THEN addressee_id ELSE requester_id END AS id
     FROM friendships
     WHERE status = 'accepted' AND (requester_id = :me OR addressee_id = :me)`,
    { me: userId },
  ).map((row) => row.id);

export const areFriends = (a, b) =>
  Boolean(
    get(
      `SELECT 1 FROM friendships WHERE status = 'accepted'
         AND ((requester_id = :a AND addressee_id = :b) OR (requester_id = :b AND addressee_id = :a))`,
      { a, b },
    ),
  );

// "@sam" → "sam" (handles are stored without the "@", compared case-insensitively).
export const normalizeHandle = (handle) => handle.trim().replace(/^@/, "");
