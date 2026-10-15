// Builds data/catalog.json — the pool — from TMDB.
//
//   npm run build-pool                 (refresh every pool movie from TMDB)
//   npm run build-pool -- --grow 500   (also add up to 500 of TMDB's most-
//                                       voted movies not in the pool yet)
//   npm run build-pool -- --offline    (cached answers only, no requests)
//
// data/seed-movies.txt is read on every run: one movie per line as
// Title|Year|Franchise|imdbId (franchise and IMDb id optional). Seeds not in
// the pool yet are added; seeds already in it set their franchise.
//
// Reads TMDB_READ_TOKEN (or TMDB_API_KEY) from .env. Restart the server
// afterwards; the app picks up the new catalog on its next start.
//
// Every movie is keyed by its TMDB id. What's curated is kept: hand-tuned
// vibes (vibeSource "hand"), franchise tags, rank order and the Reels clips.
// Everything else — title, year, rating, runtime, genres, director, cast,
// plot, poster, backdrop, trailer, age rating — comes from TMDB. Movies
// added with --grow get an estimated vibe, learnt from the hand-tuned ones.
//
// A catalog from before TMDB (ids like "m42") is converted through each
// movie's IMDb id. TMDB answers are kept in data/tmdb-cache.json (not
// committed), so a re-run only asks about what it hasn't seen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmdbConfigured, tmdbGet } from "../src/lib/tmdb.js";
import { toMovie, trainVibes } from "../src/lib/tmdbMovies.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(ROOT, "data", "catalog.json");
const CACHE = path.join(ROOT, "data", "tmdb-cache.json");
const ID_MAP = path.join(ROOT, "data", "id-map.json");
const SEEDS = path.join(ROOT, "data", "seed-movies.txt");
// --grow: only well-known movies (TMDB vote count), and real feature films.
const GROW_MIN_VOTES = 1000;
const MIN_RUNTIME = 40;

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at > -1 ? process.argv[at + 1] : undefined;
};
const OFFLINE = process.argv.includes("--offline");
const GROW = Number(argValue("--grow") ?? 0);

if (!OFFLINE && !tmdbConfigured()) {
  console.error("Set TMDB_READ_TOKEN (or TMDB_API_KEY) in .env first.");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache) + "\n");

const isTmdbId = (id) => /^\d+$/.test(String(id));

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
  String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  if (key in cache) return cache[key];
  if (OFFLINE) return undefined;
  const record = await tmdbGet(`/movie/${tmdbId}`, {
    append_to_response: "credits,videos,release_dates",
    language: "en-US",
  });
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

// ---- 1. Every pool movie, by TMDB id ---------------------------------------------------

console.log(`Pool: ${catalog.movies.length} movies${OFFLINE ? " (offline: cache only)" : ""}`);
const tmdbIdOf = new Map(); // old id → TMDB id
await eachInParallel(
  catalog.movies,
  async (movie) => {
    const tmdbId = isTmdbId(movie.id)
      ? Number(movie.id)
      : (movie.details?.tmdbId ??
        (movie.details?.imdbId ? await findByImdb(movie.details.imdbId) : null) ??
        (await findByTitle(movie.title, movie.year)));
    if (tmdbId) {
      tmdbIdOf.set(movie.id, tmdbId);
      await fetchRecord(tmdbId);
    }
  },
  (movie) => `${movie.title} (${movie.year})`,
);

// Curated parts first, so the estimate for new movies learns from the
// hand-tuned vibes against TMDB's own numbers.
const pool = [];
const seen = new Set();
const dropped = [];
const idMap = {};
for (const movie of [...catalog.movies].sort((a, b) => a.rank - b.rank)) {
  const tmdbId = tmdbIdOf.get(movie.id);
  const record = tmdbId ? cache[`movie:${tmdbId}`] : null;
  if (!record || record.adult || seen.has(String(tmdbId))) {
    dropped.push(`${movie.title} (${movie.year})`);
    continue;
  }
  seen.add(String(tmdbId));
  const fresh = toMovie(record);
  idMap[movie.id] = fresh.id;
  pool.push({
    ...fresh,
    rank: pool.length + 1,
    // Kept from the curated catalog.
    franchise: movie.franchise ?? fresh.franchise,
    vibe: movie.vibe ?? fresh.vibe,
    vibeSource: movie.vibeSource === "hand" ? "hand" : "estimated",
  });
}
trainVibes(
  pool.filter((movie) => movie.vibeSource === "hand"),
  catalog.themes,
);

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
  const record = cache[`movie:${id}`];
  if (!record || record.adult) continue;
  const movie = { ...toMovie(record), rank: pool.length + 1 };
  if (seed.franchise) movie.franchise = seed.franchise;
  pool.push(movie);
  byId.set(id, movie);
  seen.add(id);
  seeded += 1;
}

// ---- 3. --grow: TMDB's most-voted movies not in the pool yet -----------------------------

let grown = 0;
if (GROW > 0) {
  const candidates = [];
  for (let page = 1; candidates.length < GROW && page <= 500; page += 1) {
    const key = `discover:${page}`;
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
    for (const id of cache[key]) {
      if (!seen.has(String(id)) && !candidates.includes(id)) candidates.push(id);
    }
  }
  const adding = candidates.slice(0, GROW);
  console.log(`Growing: ${adding.length} candidates`);
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

// ---- 4. Write it ------------------------------------------------------------------------

const reelClips = catalog.reelClips
  .map((clip) => ({ ...clip, movieId: isTmdbId(clip.movieId) ? clip.movieId : idMap[clip.movieId] }))
  .filter((clip) => clip.movieId && seen.has(clip.movieId));

const output = {
  generatedAt: new Date().toISOString(),
  source: "TMDB",
  movies: pool.map(({ vibeSource, ...movie }) => ({ ...movie, vibeSource })),
  reelClips,
  clipSeconds: catalog.clipSeconds,
  dimensions: catalog.dimensions,
  themes: catalog.themes,
};
fs.writeFileSync(CATALOG, JSON.stringify(output, null, 1) + "\n");
if (Object.keys(idMap).some((id) => !isTmdbId(id))) {
  fs.writeFileSync(ID_MAP, JSON.stringify(idMap, null, 1) + "\n");
}

const count = (test) => pool.filter(test).length;
console.log(`\nPool: ${pool.length} movies (${seeded} new from seeds, ${grown} grown).`);
console.log(
  `  hand-tuned vibes ${count((movie) => movie.vibeSource === "hand")} · ` +
    `trailers ${count((movie) => movie.details?.trailer)} · ` +
    `backdrops ${count((movie) => movie.backdrop)} · Reels clips ${reelClips.length}`,
);
if (dropped.length > 0) {
  console.log(`  Dropped (not on TMDB, or twice): ${dropped.length} — ${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? "…" : ""}`);
}
if (notFound.length > 0) {
  console.log(`  Seeds TMDB couldn't find (${notFound.length}) — add an IMDb id as the 4th column: ${notFound.slice(0, 8).join(", ")}${notFound.length > 8 ? "…" : ""}`);
}
console.log("Restart the server to serve it.");
