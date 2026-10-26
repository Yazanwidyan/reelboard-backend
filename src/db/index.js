import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import config from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;
const statements = new Map();

const prepare = (sql) => {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
};

// Thin wrappers over node:sqlite. `params` is either an object for named
// parameters (`:name` in the SQL) or an array for positional `?`s.
const bind = (params) => (Array.isArray(params) ? params : [params]);
export const get = (sql, params = []) => prepare(sql).get(...bind(params)) ?? null;
export const all = (sql, params = []) => prepare(sql).all(...bind(params));
export const run = (sql, params = []) => prepare(sql).run(...bind(params));

// Runs `fn` inside a transaction; rolls back if it throws. Nested calls just
// join the outer transaction.
let depth = 0;
export const transaction = (fn) => {
  if (depth > 0) return fn();
  db.exec("BEGIN");
  depth += 1;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    depth -= 1;
  }
};

export const toJSON = (value) => JSON.stringify(value ?? null);
export const fromJSON = (text, fallback = null) => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

// Writes one movie into the movies table. Pool movies come from
// `npm run build-pool` (writePool); others from TMDB (lib/movies.js).
export const upsertMovie = (movie, { inPool = false, fetchedAt = Date.now() } = {}) =>
  run(
    `INSERT INTO movies (id, in_pool, rank, title, year, rating, runtime, director, genres, "cast",
                         details, description, franchise, poster, backdrop, vibe, vibe_source,
                         fetched_at)
     VALUES (:id, :inPool, :rank, :title, :year, :rating, :runtime, :director, :genres, :cast,
             :details, :description, :franchise, :poster, :backdrop, :vibe, :vibeSource,
             :fetchedAt)
     ON CONFLICT (id) DO UPDATE SET
       in_pool = excluded.in_pool, rank = excluded.rank, title = excluded.title,
       year = excluded.year, rating = excluded.rating, runtime = excluded.runtime,
       director = excluded.director, genres = excluded.genres, "cast" = excluded."cast",
       details = excluded.details, description = excluded.description,
       franchise = excluded.franchise, poster = excluded.poster, backdrop = excluded.backdrop,
       vibe = excluded.vibe, vibe_source = excluded.vibe_source, fetched_at = excluded.fetched_at`,
    {
      id: movie.id,
      inPool: inPool ? 1 : 0,
      rank: inPool ? movie.rank : null,
      title: movie.title,
      year: movie.year ?? null,
      rating: movie.rating ?? 0,
      runtime: movie.runtime ?? null,
      director: movie.director ?? null,
      genres: toJSON(movie.genres),
      cast: toJSON(movie.cast ?? []),
      details: movie.details ? toJSON(movie.details) : null,
      description: movie.description ?? null,
      franchise: movie.franchise ?? null,
      poster: movie.poster ?? null,
      backdrop: movie.backdrop ?? null,
      vibe: toJSON(movie.vibe),
      vibeSource: movie.vibeSource ?? "estimated",
      fetchedAt,
    },
  );

// The pool — about 8,000 movies — lives in the movies table (in_pool = 1),
// written by `npm run build-pool` from TMDB. Only what people chose by hand
// is kept in git, in data/curation.json: the curated list with its
// hand-tuned vibes and franchises, the Taste DNA vocabulary and the Reels
// clips. The last two are read from it on every start.
const readCuration = () => JSON.parse(fs.readFileSync(config.curationPath, "utf8"));

// The Reels clips, for the pool movies they're for.
const syncClips = (curation) => {
  run("DELETE FROM reel_clips");
  for (const clip of curation.reelClips) {
    if (!get("SELECT 1 FROM movies WHERE id = ? AND in_pool = 1", [clip.movieId])) continue;
    run(
      `INSERT INTO reel_clips (movie_id, youtube_id, start, "end")
       VALUES (:movieId, :youtubeId, :start, :end)`,
      clip,
    );
  }
};

// Makes `movies` the pool (build-pool, and the tests' fixture). A movie
// dropped from the pool stays as an ordinary movie — people may have it
// saved. The server reads the pool once, so restart it afterwards.
export const writePool = (movies) =>
  transaction(() => {
    run("UPDATE movies SET in_pool = 0, rank = NULL WHERE in_pool = 1");
    for (const movie of movies) upsertMovie(movie, { inPool: true });
    syncClips(readCuration());
  });

export const poolSize = () => get("SELECT COUNT(*) AS n FROM movies WHERE in_pool = 1").n;

// The sagas, as build-pool resolved them (lib/collections.js reads them).
export const writeSagas = (sagas) =>
  transaction(() => {
    run("DELETE FROM sagas");
    sagas.forEach((saga, position) =>
      run("INSERT INTO sagas (id, position, definition) VALUES (?, ?, ?)", [
        saga.id,
        position,
        toJSON(saga),
      ]),
    );
  });

export const readSagas = () =>
  all("SELECT definition FROM sagas ORDER BY position").map((row) => fromJSON(row.definition));

// schema.sql only creates what's missing, so a column added to an existing
// table after a database was created is added here.
const migrate = () => {
  const userColumns = new Set(all("PRAGMA table_info(users)").map((column) => column.name));
  if (!userColumns.has("has_password")) {
    db.exec("ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1");
  }
  // Ranks replaced XP (the old `xp` column stays, unused).
  if (!userColumns.has("ranks")) {
    db.exec("ALTER TABLE users ADD COLUMN ranks INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumns.has("rank_ids")) {
    db.exec("ALTER TABLE users ADD COLUMN rank_ids TEXT NOT NULL DEFAULT '[]'");
  }
  // The profile's cover: a film's still.
  if (!userColumns.has("cover_movie_id")) {
    db.exec("ALTER TABLE users ADD COLUMN cover_movie_id TEXT");
  }
  // Suspension, by an admin.
  if (!userColumns.has("suspended_at")) {
    db.exec("ALTER TABLE users ADD COLUMN suspended_at INTEGER");
    db.exec("ALTER TABLE users ADD COLUMN suspended_reason TEXT");
  }
};

// From data/curation.json: the Taste DNA vocabulary and the clip length.
export let catalogMeta = { dimensions: [], themes: {}, clipSeconds: 30 };

// 2: movies are TMDB movies, by TMDB id. Databases from before that keyed
// everything (library, boards, clubs…) by the old catalog's "m1"… ids.
const SCHEMA_VERSION = 2;

export const openDatabase = (filename = config.databasePath) => {
  if (db) return db;
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new DatabaseSync(filename);
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'movies'").get();
  if (existing && version < SCHEMA_VERSION) {
    db.close();
    db = null;
    throw new Error(
      `${filename} is from before movies came from TMDB (its movie ids no longer exist). ` +
        "Stop the server, delete that file (and its -wal / -shm files) to start fresh — this deletes all accounts — and start again.",
    );
  }
  db.exec("PRAGMA foreign_keys = ON");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  migrate();
  const curation = readCuration();
  catalogMeta = {
    dimensions: curation.dimensions,
    themes: curation.themes,
    clipSeconds: curation.clipSeconds,
  };
  transaction(() => syncClips(curation));
  return db;
};

export const closeDatabase = () => {
  statements.clear();
  db?.close();
  db = null;
};
