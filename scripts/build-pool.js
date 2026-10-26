// Builds the pool — ReelBoard's ~8,000 movies — from TMDB, into the
// database (the movies table, in_pool = 1). Git keeps only what people
// chose by hand: data/curation.json and data/seed-movies.txt.
//
//   npm run build-pool                 (curated + seeds + every TMDB movie
//                                       with 500+ votes)
//   npm run build-pool -- --grow 500   (only up to 500 beyond the curated
//                                       ones and seeds)
//   npm run build-pool -- --offline    (cached answers only, no requests)
//
// Order (it's the movies' rank): data/curation.json's curated list first,
// then new seeds, then TMDB's most-voted movies. From the curation: the
// hand-tuned vibes (vibeSource "hand") and hand-set franchises. Everything
// else — title, year, rating, runtime, genres, director, cast and crew,
// plot, poster, backdrop, trailer, age rating — comes from TMDB, and every
// other movie's vibe is estimated, learnt from the hand-tuned ones.
//
// data/seed-movies.txt: one movie per line as Title|Year|Franchise|imdbId
// (franchise and IMDb id optional). Seeds not in the pool yet are added;
// seeds already in it set their franchise.
//
// Reads TMDB_READ_TOKEN (or TMDB_API_KEY) from .env, and DATABASE_PATH like
// the server. TMDB's answers are kept in data/tmdb-cache.json (not
// committed), so a re-run only asks about what it hasn't seen. Restart the
// server afterwards — it reads the pool once.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../src/config.js";
import { closeDatabase, openDatabase, writePool, writeSagas } from "../src/db/index.js";
import { tmdbConfigured, tmdbGet } from "../src/lib/tmdb.js";
import { createSagaResolver, resolveRanks } from "../src/lib/sagaSources.js";
import { MOVIE_PARAMS, toMovie, trainVibes } from "../src/lib/tmdbMovies.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "data", "tmdb-cache.json");
const SEEDS = path.join(ROOT, "data", "seed-movies.txt");
// Growing: only well-known movies (TMDB vote count), and real feature films.
// 500+ votes is about 8,000 movies on TMDB.
const GROW_MIN_VOTES = 500;
const MIN_RUNTIME = 40;

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at > -1 ? process.argv[at + 1] : undefined;
};
const OFFLINE = process.argv.includes("--offline");
const GROW = argValue("--grow") === undefined ? Infinity : Number(argValue("--grow"));

if (!OFFLINE && !tmdbConfigured()) {
  console.error("Set TMDB_READ_TOKEN (or TMDB_API_KEY) in .env first.");
  process.exit(1);
}

const curation = JSON.parse(fs.readFileSync(config.curationPath, "utf8"));
// Kept out of the pool by hand (the admin site's "remove from pool").
const excluded = new Set((curation.excluded ?? []).map(String));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache) + "\n");

// ---- TMDB, through the cache ---------------------------------------------------------

// The TMDB id for an IMDb id, or null.
const findByImdb = async (imdbId) => {
  const key = `imdb:${imdbId}`;
  if (key in cache) return cache[key];
  if (OFFLINE) return undefined;
  const found = await tmdbGet(`/find/${imdbId}`, { external_source: "imdb_id" });
  cache[key] = found?.movie_results?.[0]?.id ?? null;
  return cache[key];
};

// No (right) IMDb id: the TMDB movie with this exact title, released that
// year (or a year either side).
const normalize = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
// Titles are compared loosely: no leading "the/a/an", no "Episode IV -",
// and a subtitle on either side is fine ("Glass Onion" is TMDB's "Glass
// Onion: A Knives Out Mystery"). The year must be within one.
const bareTitle = (text) =>
  normalize(text)
    .replace(/^(the|a|an) /, "")
    .replace(/\bepisode [ivx]+ /, "");
const titlesMatch = (wanted, found) => {
  const a = bareTitle(wanted);
  const b = bareTitle(found);
  return a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `);
};
const findByTitle = async (title, year) => {
  const key = `title2:${normalize(title)}|${year}`;
  if (key in cache) return cache[key];
  if (OFFLINE) return undefined;
  const near = (movie) => Math.abs(Number(movie.release_date?.slice(0, 4)) - year) <= 1;
  // "Star Wars: Episode VII - The Force Awakens" is searched as "Star Wars:
  // The Force Awakens" too.
  const queries = [...new Set([title, title.replace(/Episode [IVX]+ - /i, "")])];
  let match = null;
  for (const query of queries) {
    const data = await tmdbGet("/search/movie", { query, include_adult: "false" });
    const results = (data?.results ?? []).filter(near);
    match =
      results.find((movie) => bareTitle(movie.title) === bareTitle(title)) ??
      results.find((movie) => titlesMatch(title, movie.title)) ??
      null;
    if (match) break;
  }
  cache[key] = match?.id ?? null;
  return cache[key];
};

// The full TMDB record for a movie, as the raw fields toMovie() reads.
const fetchRecord = async (tmdbId) => {
  const key = `movie:${tmdbId}`;
  // Records cached before images were asked for are fetched again.
  if (key in cache && (cache[key] === null || cache[key].images)) return cache[key];
  if (OFFLINE) return cache[key];
  const record = await tmdbGet(`/movie/${tmdbId}`, MOVIE_PARAMS);
  // Only what toMovie() reads, so the cache stays a sensible size.
  cache[key] = record && {
    ...Object.fromEntries(
      [
        "id", "title", "original_title", "original_language", "release_date", "vote_average",
        "vote_count", "popularity", "runtime", "genres", "imdb_id", "tagline", "spoken_languages",
        "production_countries", "budget", "revenue", "belongs_to_collection", "overview",
        "poster_path", "backdrop_path", "adult",
      ].map((field) => [field, record[field]]),
    ),
    credits: {
      cast: (record.credits?.cast ?? []).slice(0, 15),
      crew: (record.credits?.crew ?? []).filter((person) => ["Directing", "Writing"].includes(person.department)),
    },
    videos: { results: (record.videos?.results ?? []).filter((video) => video.site === "YouTube") },
    release_dates: {
      results: (record.release_dates?.results ?? []).filter((country) => country.iso_3166_1 === "US"),
    },
    // Enough for pickBackdrop / pickLogo: the best few of each.
    images: Object.fromEntries(
      ["backdrops", "logos"].map((kind) => [
        kind,
        [...(record.images?.[kind] ?? [])]
          .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0) || (b.vote_count ?? 0) - (a.vote_count ?? 0))
          .slice(0, 6)
          .map(({ file_path, iso_639_1, vote_average, vote_count, width, height }) => ({
            file_path, iso_639_1, vote_average, vote_count, width, height,
          })),
      ]),
    ),
  };
  return cache[key];
};

// A few at a time, saving the cache as it goes.
const eachInParallel = async (items, work, label) => {
  let done = 0;
  const queue = [...items];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await work(item);
        } catch (error) {
          console.warn(`  ${label(item)}: ${error.message} — skipped`);
        }
        done += 1;
        if (done % 100 === 0) {
          saveCache();
          console.log(`  ${done}/${items.length}`);
        }
      }
    }),
  );
  saveCache();
};

// ---- 1. The curated list --------------------------------------------------------------

console.log(`Curated: ${curation.movies.length} movies${OFFLINE ? " (offline: cache only)" : ""}`);
await eachInParallel(curation.movies, (entry) => fetchRecord(entry.id), (entry) => entry.title);

// The hand-tuned vibes first: every other movie's is estimated from them.
const handTuned = curation.movies
  .filter((entry) => entry.vibe && cache[`movie:${entry.id}`])
  .map((entry) => ({ ...toMovie(cache[`movie:${entry.id}`]), vibe: entry.vibe }));
trainVibes(handTuned, curation.themes);

const pool = [];
const seen = new Set();
const dropped = [];
for (const entry of curation.movies) {
  const record = cache[`movie:${entry.id}`];
  if (!record || record.adult || seen.has(entry.id)) {
    dropped.push(entry.title);
    continue;
  }
  seen.add(entry.id);
  const fresh = toMovie(record);
  pool.push({
    ...fresh,
    rank: pool.length + 1,
    franchise: entry.franchise ?? fresh.franchise,
    vibe: entry.vibe ?? fresh.vibe,
    vibeSource: entry.vibe ? "hand" : "estimated",
  });
}

// ---- 2. Seeds: data/seed-movies.txt -------------------------------------------------------

const seeds = fs.existsSync(SEEDS)
  ? fs
      .readFileSync(SEEDS, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const [title, year, franchise, imdbId] = line.split("|").map((part) => part?.trim());
        return { title, year: Number(year), franchise: franchise || null, imdbId: imdbId || null };
      })
  : [];
const seedIds = new Map();
await eachInParallel(
  seeds,
  async (seed) => {
    const id =
      (seed.imdbId ? await findByImdb(seed.imdbId) : null) ?? (await findByTitle(seed.title, seed.year));
    if (id) {
      seedIds.set(seed, String(id));
      if (!seen.has(String(id))) await fetchRecord(id);
    }
  },
  (seed) => `${seed.title} (${seed.year})`,
);
let seeded = 0;
const notFound = [];
const byId = new Map(pool.map((movie) => [movie.id, movie]));
for (const seed of seeds) {
  const id = seedIds.get(seed);
  if (!id) {
    notFound.push(`${seed.title} (${seed.year})`);
    continue;
  }
  if (byId.has(id)) {
    if (seed.franchise) byId.get(id).franchise = seed.franchise;
    continue;
  }
  if (excluded.has(id)) continue;
  const record = cache[`movie:${id}`];
  if (!record || record.adult) continue;
  const movie = { ...toMovie(record), rank: pool.length + 1 };
  if (seed.franchise) movie.franchise = seed.franchise;
  pool.push(movie);
  byId.set(id, movie);
  seen.add(id);
  seeded += 1;
}

// ---- 3. TMDB's most-voted movies not in the pool yet -------------------------------------

let grown = 0;
if (GROW > 0) {
  const candidates = [];
  for (let page = 1; candidates.length < GROW && page <= 500; page += 1) {
    const key = `discover:${GROW_MIN_VOTES}:${page}`;
    if (!(key in cache)) {
      if (OFFLINE) break;
      const data = await tmdbGet("/discover/movie", {
        sort_by: "vote_count.desc",
        "vote_count.gte": GROW_MIN_VOTES,
        include_adult: "false",
        page,
      });
      cache[key] = (data?.results ?? []).map((movie) => movie.id);
      if ((data?.results ?? []).length === 0) break;
    }
    if (cache[key].length === 0) break;
    for (const id of cache[key]) {
      if (!seen.has(String(id)) && !excluded.has(String(id)) && !candidates.includes(id)) {
        candidates.push(id);
      }
    }
  }
  const adding = candidates.slice(0, GROW);
  console.log(`Growing: ${adding.length} of TMDB's most-voted movies`);
  await eachInParallel(adding, fetchRecord, (id) => `TMDB ${id}`);
  for (const id of adding) {
    const record = cache[`movie:${id}`];
    if (!record || record.adult || (record.runtime ?? 0) < MIN_RUNTIME) continue;
    if (record.genres?.some((genre) => genre.id === 99)) continue; // documentaries
    if (!record.poster_path) continue;
    const movie = toMovie(record); // estimated vibe, from the model above
    pool.push({ ...movie, rank: pool.length + 1 });
    seen.add(movie.id);
    grown += 1;
  }
}

// ---- 4. Sagas: data/curation.json's hand-made collections ---------------------------
//
// Each saga's `from` becomes its films (released ones only, oldest first),
// every one of them added to the pool if it isn't in yet; its ranks become
// film counts; and it gets its artwork (the one picked in the admin site,
// or the franchise's backdrop, or the director's / actor's photo, or its
// best-known film's backdrop).

const MIN_SAGA_SIZE = 3;

// The rules themselves live in lib/sagaSources (the admin site previews
// them with the same code); here they read through the file cache.
const cached = async (key, fetch) => {
  if (key in cache) return cache[key];
  if (OFFLINE) return undefined;
  cache[key] = await fetch();
  return cache[key];
};
const { resolveSaga } = createSagaResolver({ cached, findByTitle });

const sagaPlan = curation.sagas ?? [];
console.log(`Sagas: ${sagaPlan.length}`);
const resolvedSagas = [];
for (const saga of sagaPlan) {
  try {
    resolvedSagas.push({ saga, ...(await resolveSaga(saga)) });
  } catch (error) {
    console.warn(`  ${saga.title}: ${error.message} — skipped`);
  }
}
// Their films, into the pool.
const sagaMovieIds = [...new Set(resolvedSagas.flatMap((entry) => entry.ids.map(String)))];
await eachInParallel(sagaMovieIds.filter((id) => !seen.has(id)), fetchRecord, (id) => `TMDB ${id}`);
let sagaAdded = 0;
for (const id of sagaMovieIds) {
  if (seen.has(id)) continue;
  const record = cache[`movie:${id}`];
  if (!record || record.adult || !record.poster_path) continue;
  pool.push({ ...toMovie(record), rank: pool.length + 1 });
  seen.add(id);
  sagaAdded += 1;
}
const poolById = new Map(pool.map((movie) => [movie.id, movie]));
const sagas = [];
for (const { saga, ids, art, person, source } of resolvedSagas) {
  const movieIds = ids.map(String).filter((id) => poolById.has(id));
  if (movieIds.length < MIN_SAGA_SIZE) {
    console.warn(`  ${saga.title}: only ${movieIds.length} films (${source}) — left out`);
    continue;
  }
  const ranks = resolveRanks(saga.ranks, movieIds.length);
  // Without its own artwork: the backdrop of its best-known film.
  const fallback = movieIds
    .map((id) => poolById.get(id))
    .filter((movie) => movie.backdrop)
    .sort((a, b) => (b.details?.votes ?? 0) - (a.details?.votes ?? 0))[0]?.backdrop;
  sagas.push({
    id: `saga-${saga.id}`,
    type: "saga",
    kind: saga.kind,
    title: saga.title,
    subtitle: saga.subtitle,
    movieIds,
    ranks,
    art: saga.art ?? art ?? (fallback ? { backdrop: fallback } : null),
    ...(person ? { person } : {}),
  });
  console.log(
    `  ${saga.title.padEnd(24)} ${String(movieIds.length).padStart(2)} films · ${ranks.map((rank) => `${rank.title} ${rank.at}`).join(" → ")}   (${source})`,
  );
}

// ---- 5. Into the database ------------------------------------------------------------------

openDatabase();
writePool(pool);
writeSagas(sagas);
closeDatabase();

const count = (test) => pool.filter(test).length;
console.log(
  `\nPool: ${pool.length} movies in ${config.databasePath} (${seeded} new from seeds, ${grown} grown, ${sagaAdded} for sagas). Sagas: ${sagas.length}.`,
);
console.log(
  `  hand-tuned vibes ${count((movie) => movie.vibeSource === "hand")} · ` +
    `trailers ${count((movie) => movie.details?.trailer)} · ` +
    `backdrops ${count((movie) => movie.backdrop)}`,
);
if (dropped.length > 0) {
  console.log(`  Curated but not on TMDB any more: ${dropped.length} — ${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? "…" : ""}`);
}
if (notFound.length > 0) {
  console.log(`  Seeds TMDB couldn't find (${notFound.length}) — add an IMDb id as the 4th column: ${notFound.slice(0, 8).join(", ")}${notFound.length > 8 ? "…" : ""}`);
}
console.log("Restart the server to use it.");
