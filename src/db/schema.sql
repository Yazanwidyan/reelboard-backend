-- All timestamps are milliseconds since the epoch (Date.now()), the same
-- unit the app already stores, so values pass straight through.
-- JSON columns hold arrays/objects serialized as text.

-- Every movie the server knows, by TMDB id ("603" is The Matrix). The
-- pool (in_pool = 1) is data/catalog.json, loaded on every start: the
-- curated movies with hand-tuned or estimated vibes that Swipe, Spin,
-- recommendations and collections draw from. Any other TMDB movie is added
-- the first time someone opens or saves it, and refreshed when it's older
-- than a week (lib/movies.js).
CREATE TABLE IF NOT EXISTS movies (
  id          TEXT PRIMARY KEY,
  in_pool     INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER,                  -- pool order (pool only)
  title       TEXT NOT NULL,
  year        INTEGER,
  rating      REAL NOT NULL DEFAULT 0,  -- TMDB's average vote, 0–10
  runtime     INTEGER,
  director    TEXT,
  genres      TEXT NOT NULL,            -- JSON string[] (the app's 12 genres)
  "cast"      TEXT NOT NULL,            -- JSON string[]
  details     TEXT,                     -- JSON object | null
  description TEXT,
  franchise   TEXT,
  poster      TEXT,
  backdrop    TEXT,
  vibe        TEXT NOT NULL,            -- JSON { dims: number[6], themes: string[] }
  vibe_source TEXT NOT NULL DEFAULT 'estimated', -- 'hand' | 'estimated'
  fetched_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS movies_pool ON movies (in_pool, rank);

CREATE TABLE IF NOT EXISTS reel_clips (
  movie_id   TEXT PRIMARY KEY REFERENCES movies(id),
  youtube_id TEXT NOT NULL,
  start      INTEGER NOT NULL,
  "end"      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash      TEXT NOT NULL,
  -- 0 for accounts made with Google / Apple only (password_hash is then a
  -- random hash nobody knows).
  has_password       INTEGER NOT NULL DEFAULT 1,
  handle             TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- without the "@"
  display_name       TEXT NOT NULL,
  bio                TEXT NOT NULL DEFAULT '',
  avatar_uri         TEXT,
  color              TEXT NOT NULL,
  -- Worked out from the watch history (lib/ranks.js): how many ranks, which
  -- ones (JSON ids, for how rare each is), and the title they make
  -- (1 = Extra … 7 = Legend, lib/titles.js) — what friends see.
  ranks              INTEGER NOT NULL DEFAULT 0,
  rank_ids           TEXT NOT NULL DEFAULT '[]',
  level              INTEGER NOT NULL DEFAULT 1,
  top_ten            TEXT NOT NULL DEFAULT '[]',   -- JSON movie ids: the S tier's order, #1 first
  pinned_collections TEXT NOT NULL DEFAULT '[]',   -- JSON collection ids
  created_at         INTEGER NOT NULL
);

-- Google / Apple sign-ins linked to an account. `subject` is the provider's
-- stable user id (the token's "sub"), which never changes even if the email does.
CREATE TABLE IF NOT EXISTS auth_identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google','apple')),
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_by_user ON auth_identities (user_id);

-- One row per user: everything from the app's small single-value stores.
CREATE TABLE IF NOT EXISTS user_state (
  user_id                 TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language                TEXT NOT NULL DEFAULT 'en',
  theme                   TEXT NOT NULL DEFAULT 'system',
  preferences             TEXT NOT NULL,                -- JSON { genres, minRating, decade, runtime }
  has_completed_onboarding INTEGER NOT NULL DEFAULT 0,
  tips_seen               TEXT NOT NULL DEFAULT '{}',   -- JSON { [tipId]: true }
  recent_searches         TEXT NOT NULL DEFAULT '[]',   -- JSON string[], newest first
  unlocked_collections    TEXT NOT NULL DEFAULT '[]',   -- JSON collection ids
  picked_movie_id         TEXT REFERENCES movies(id),
  pick_mood               TEXT,                         -- mood of a Home mood-chip pick
  leanings                TEXT                          -- JSON number[6] | null
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id TEXT NOT NULL REFERENCES movies(id),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, movie_id)
);

-- One row per movie; a rewatch bumps watch_count and watched_at.
CREATE TABLE IF NOT EXISTS watched (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id    TEXT NOT NULL REFERENCES movies(id),
  watched_at  INTEGER NOT NULL,
  tier        TEXT CHECK (tier IN ('S','A','B','C','D','F')),
  rating      REAL,                     -- legacy 0.5–5 stars, superseded by tier
  watch_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, movie_id)
);
CREATE INDEX IF NOT EXISTS watched_by_time ON watched (user_id, watched_at DESC);

CREATE TABLE IF NOT EXISTS taste_aspects (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id TEXT NOT NULL REFERENCES movies(id),
  aspects  TEXT NOT NULL,               -- JSON string[]
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS taste_passes (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id TEXT NOT NULL REFERENCES movies(id),
  at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_by_user ON boards (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS board_movies (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  movie_id TEXT NOT NULL REFERENCES movies(id),
  position INTEGER NOT NULL,            -- newest last, like the app
  PRIMARY KEY (board_id, movie_id)
);

-- The challenge object itself is generated by the app; it's kept whole in
-- `data`. At most one 'active' challenge per user.
CREATE TABLE IF NOT EXISTS challenges (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('active','completed','skipped')),
  target_movie_id TEXT,
  data            TEXT NOT NULL,
  accepted_at     INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_challenge
  ON challenges (user_id) WHERE status = 'active';

-- A friendship is a single row; status 'pending' until the addressee accepts.
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE INDEX IF NOT EXISTS friendships_by_addressee ON friendships (addressee_id);

-- The friends feed. type: watched | tier | watchlist | badge | set
CREATE TABLE IF NOT EXISTS activity (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  movie_id   TEXT REFERENCES movies(id),
  data       TEXT NOT NULL DEFAULT '{}', -- JSON: { tier } | { badge } | { set, count }
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_by_user ON activity (user_id, created_at DESC);

-- Responses to changes sent with an "Idempotency-Key" header, so a change
-- the app re-sends (it lost the reply, or replayed its offline queue) is
-- applied once. Kept a week (see middleware/idempotency.js).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT,                      -- JSON response body, null for 204
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_by_age ON idempotency_keys (created_at);

-- Movie nights across phones: the host makes a room with a stack of movies
-- and a short code; friends join with the code, everyone swipes on their own
-- phone, and the movies everyone kept are revealed once all are done.
CREATE TABLE IF NOT EXISTS movie_nights (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  host_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_ids  TEXT NOT NULL,             -- JSON movie ids, in swipe order
  status     TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS movie_night_members (
  night_id  TEXT NOT NULL REFERENCES movie_nights(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  kept      TEXT,                       -- JSON movie ids, null until done
  done_at   INTEGER,
  PRIMARY KEY (night_id, user_id)
);
CREATE INDEX IF NOT EXISTS movie_night_members_by_user ON movie_night_members (user_id);

-- Phones to send push notifications to (Expo push tokens). One account can
-- have several phones; a token that Expo reports as gone is removed.
CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_by_user ON push_tokens (user_id);

-- Clubs: a group with a shared board, a "now watching" pick set by the
-- owner, and a feed of what members do with the club's movies. Joined by
-- invite code only — clubs aren't listed or searchable.
CREATE TABLE IF NOT EXISTS clubs (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  owner_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code            TEXT NOT NULL UNIQUE,
  now_watching_movie_id  TEXT REFERENCES movies(id),
  now_watching_set_at    INTEGER,
  created_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS club_members (
  club_id   TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner','member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX IF NOT EXISTS club_members_by_user ON club_members (user_id);

-- The club's shared board, oldest first.
CREATE TABLE IF NOT EXISTS club_movies (
  club_id  TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  movie_id TEXT NOT NULL REFERENCES movies(id),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (club_id, movie_id)
);

-- The sagas: data/curation.json's hand-made collections, turned into movie
-- ids, rank thresholds and artwork by `npm run build-pool`. One row each,
-- in the curation's order; `definition` is the collection as the app gets
-- it (lib/collections.js).
CREATE TABLE IF NOT EXISTS sagas (
  id         TEXT PRIMARY KEY,
  position   INTEGER NOT NULL,
  definition TEXT NOT NULL              -- JSON
);
