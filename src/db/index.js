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

// Writes one movie (the catalog's shape) into the movies table. Pool
// movies come from data/catalog.json; others from TMDB (lib/movies.js).
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

// Loads data/catalog.json into the movies table as the pool. Runs on every
// start, so editing the file (or `npm run build-pool`) and restarting is
// enough. A movie dropped from the pool stays as an ordinary movie — people
// may have it saved.
const syncCatalog = () => {
  if (!fs.existsSync(config.catalogPath)) {
    throw new Error(`No catalog at ${config.catalogPath} — run "npm run build-pool" first`);
  }
  const catalog = JSON.parse(fs.readFileSync(config.catalogPath, "utf8"));
  transaction(() => {
    run("UPDATE movies SET in_pool = 0, rank = NULL WHERE in_pool = 1");
    for (const movie of catalog.movies) upsertMovie(movie, { inPool: true });
    run("DELETE FROM reel_clips");
    for (const clip of catalog.reelClips) {
      run(
        `INSERT INTO reel_clips (movie_id, youtube_id, start, "end")
         VALUES (:movieId, :youtubeId, :start, :end)`,
        clip,
      );
    }
  });
  return catalog;
};

// schema.sql only creates what's missing, so a column added to an existing
// table after a database was created is added here.
const migrate = () => {
  const userColumns = new Set(all("PRAGMA table_info(users)").map((column) => column.name));
  if (!userColumns.has("has_password")) {
    db.exec("ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1");
  }
};

export let catalogMeta = { dimensions: [], themes: {}, clipSeconds: 30, handTagged: [] };

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
  const catalog = syncCatalog();
  catalogMeta = {
    dimensions: catalog.dimensions,
    themes: catalog.themes,
    clipSeconds: catalog.clipSeconds,
    // What the vibe estimate learns from (lib/movies.js).
    handTagged: catalog.movies.filter((movie) => movie.vibeSource === "hand"),
  };
  return db;
};

export const closeDatabase = () => {
  statements.clear();
  db?.close();
  db = null;
};
