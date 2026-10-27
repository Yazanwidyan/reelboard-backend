import { all, fromJSON, get } from "../db/index.js";
import { accentOf, isPro, proOf } from "./pro.js";
import { titleName } from "./titles.js";

// Avatar ring colors, the same family the app's mock friends use.
const COLORS = ["#8FD3F5", "#F8E08E", "#A4E59B", "#A9C4FF", "#F5B98F", "#F2A7C3", "#C9B6F2"];

export const pickColor = (seed) => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
};

// How other people see a user — same fields as the app's mock friends
// (name, "@handle", color), their ranks and title (`level` is the title's
// step, 1–7), plus avatar and bio.
export const toPublicUser = (row) => ({
  id: row.id,
  name: row.display_name,
  handle: `@${row.handle}`,
  color: row.color,
  level: row.level,
  ranks: row.ranks ?? 0,
  title: titleName(row.level),
  avatarUri: row.avatar_uri,
  coverMovieId: row.cover_movie_id ?? null,
  bio: row.bio,
  // ReelBoard Pro: a badge, and the accent they chose.
  pro: isPro(row),
  accent: accentOf(row),
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
  coverMovieId: row.cover_movie_id ?? null,
  color: row.color,
  ranks: row.ranks ?? 0,
  rankIds: fromJSON(row.rank_ids, []),
  level: row.level,
  title: titleName(row.level),
  topTen: fromJSON(row.top_ten, []),
  pinnedCollections: fromJSON(row.pinned_collections, []),
  pro: proOf(row),
  accent: accentOf(row),
  createdAt: row.created_at,
});

export const getUserRow = (userId) => get("SELECT * FROM users WHERE id = ?", [userId]);

// What a suspended account is told when it tries to sign in or use the app.
export const SUSPENDED_MESSAGE = "This account is suspended";
export const isSuspended = (row) => row?.suspended_at != null;

// Your friends — leaving out suspended accounts, which nobody sees.
export const friendIdsOf = (userId) =>
  all(
    `SELECT friend.id FROM (
       SELECT CASE WHEN requester_id = :me THEN addressee_id ELSE requester_id END AS id
       FROM friendships
       WHERE status = 'accepted' AND (requester_id = :me OR addressee_id = :me)
     ) AS friend JOIN users ON users.id = friend.id
     WHERE users.suspended_at IS NULL`,
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
