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

// Loads data/catalog.json into the movies table. Runs on every start as an
// upsert, so re-running `npm run import-catalog` and restarting is enough to
// pick up catalog changes.
const syncCatalog = () => {
  if (!fs.existsSync(config.catalogPath)) {
    throw new Error(`No catalog at ${config.catalogPath} — run "npm run import-catalog" first`);
  }
  const catalog = JSON.parse(fs.readFileSync(config.catalogPath, "utf8"));
  transaction(() => {
    for (const movie of catalog.movies) {
      run(
        `INSERT INTO movies (id, rank, title, year, rating, runtime, director, genres, "cast",
                             details, description, franchise, poster, backdrop, vibe)
         VALUES (:id, :rank, :title, :year, :rating, :runtime, :director, :genres, :cast,
                 :details, :description, :franchise, :poster, :backdrop, :vibe)
         ON CONFLICT (id) DO UPDATE SET
           rank = excluded.rank, title = excluded.title, year = excluded.year,
           rating = excluded.rating, runtime = excluded.runtime, director = excluded.director,
           genres = excluded.genres, "cast" = excluded."cast", details = excluded.details,
           description = excluded.description, franchise = excluded.franchise,
           poster = excluded.poster, backdrop = excluded.backdrop, vibe = excluded.vibe`,
        {
          id: movie.id,
          rank: movie.rank,
          title: movie.title,
          year: movie.year,
          rating: movie.rating,
          runtime: movie.runtime,
          director: movie.director ?? null,
          genres: toJSON(movie.genres),
          cast: toJSON(movie.cast ?? []),
          details: movie.details ? toJSON(movie.details) : null,
          description: movie.description ?? null,
          franchise: movie.franchise ?? null,
          poster: movie.poster ?? null,
          backdrop: movie.backdrop ?? null,
          vibe: toJSON(movie.vibe),
        },
      );
    }
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

export let catalogMeta = { dimensions: [], themes: {}, clipSeconds: 30 };

export const openDatabase = (filename = config.databasePath) => {
  if (db) return db;
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  const catalog = syncCatalog();
  catalogMeta = {
    dimensions: catalog.dimensions,
    themes: catalog.themes,
    clipSeconds: catalog.clipSeconds,
  };
  return db;
};

export const closeDatabase = () => {
  statements.clear();
  db?.close();
  db = null;
};
