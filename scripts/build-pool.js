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
      if (!seen.has(String(id)) && !candidates.includes(id)) candidates.push(id);
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
// film counts; and it gets its artwork (the franchise's backdrop, or the
// director's / actor's photo, or its best-known film's backdrop).

const today = new Date().toISOString().slice(0, 10);
const released = (date) => Boolean(date) && date <= today;
const DOCUMENTARY = 99;
// An actor's saga: lead roles only (billed in the top three) in films
// people know.
const LEAD_ORDER = 2;
const ACTOR_MIN_VOTES = 1500;
const DIRECTOR_MIN_VOTES = 500;
const MIN_SAGA_SIZE = 3;

const cached = async (key, fetch) => {
  if (key in cache) return cache[key];
  if (OFFLINE) return undefined;
  cache[key] = await fetch();
  return cache[key];
};

const tmdbCollection = (id) =>
  cached(`collection:${id}`, async () => {
    const data = await tmdbGet(`/collection/${id}`, { language: "en-US" });
    return (
      data && {
        name: data.name,
        backdrop: data.backdrop_path ?? null,
        parts: (data.parts ?? []).map(({ id: part, release_date, adult }) => ({ id: part, release_date, adult })),
      }
    );
  });

const findPerson = (name) =>
  cached(`person:${name.toLowerCase()}`, async () => {
    const data = await tmdbGet("/search/person", { query: name, include_adult: "false" });
    const person = (data?.results ?? []).find((result) => result.name.toLowerCase() === name.toLowerCase());
    return person ? { id: person.id, name: person.name, photo: person.profile_path ?? null } : null;
  });

const credits = (personId) =>
  cached(`credits:${personId}`, async () => {
    const data = await tmdbGet(`/person/${personId}/movie_credits`, { language: "en-US" });
    const slim = ({ id, order, job, character, vote_count, release_date, genre_ids, adult }) => ({
      id, order, job, character, vote_count, release_date, genre_ids, adult,
    });
    return data && { cast: (data.cast ?? []).map(slim), crew: (data.crew ?? []).map(slim) };
  });

const companyFilms = (companyId, minVotes) =>
  cached(`company:${companyId}:${minVotes}`, async () => {
    const ids = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await tmdbGet("/discover/movie", {
        with_companies: companyId,
        "vote_count.gte": minVotes,
        "with_runtime.gte": MIN_RUNTIME,
        sort_by: "primary_release_date.asc",
        include_adult: "false",
        page,
      });
      ids.push(...(data?.results ?? []).filter((movie) => released(movie.release_date)).map((movie) => movie.id));
      if (page >= (data?.total_pages ?? 0)) break;
    }
    return ids;
  });

// A person's films for a saga: the credits that count — the best-known
// `top` of them — oldest first.
const pickCredits = (list, { minVotes, top }) =>
  list
    .filter(
      (credit) =>
        !credit.adult &&
        released(credit.release_date) &&
        (credit.vote_count ?? 0) >= minVotes &&
        !(credit.genre_ids ?? []).includes(DOCUMENTARY),
    )
    .filter((credit, i, all) => all.findIndex((other) => other.id === credit.id) === i)
    .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .slice(0, top ?? Infinity)
    // Then oldest first, like every saga.
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .map((credit) => credit.id);

// → { ids, art, source } — `source` says what it resolved to, for the log.
const resolveSaga = async ({ from }) => {
  if (from.tmdbCollections) {
    const found = await Promise.all(from.tmdbCollections.map(tmdbCollection));
    const parts = found
      .filter(Boolean)
      .flatMap((collection) => collection.parts)
      .filter((part) => !part.adult && released(part.release_date))
      .sort((a, b) => a.release_date.localeCompare(b.release_date));
    const backdrop = found.find((collection) => collection?.backdrop)?.backdrop;
    return {
      ids: parts.map((part) => part.id),
      art: backdrop ? { backdrop: `https://image.tmdb.org/t/p/w1280${backdrop}` } : null,
      source: found.map((collection) => collection?.name ?? "?").join(" + "),
    };
  }
  if (from.movies) {
    const ids = [];
    const missing = [];
    for (const line of from.movies) {
      const [title, year] = line.split("|");
      const id = await findByTitle(title, Number(year));
      if (id) ids.push(id);
      else missing.push(line);
    }
    return { ids, art: null, source: `${ids.length} listed${missing.length ? `, not found: ${missing.join(", ")}` : ""}` };
  }
  if (from.company) {
    return { ids: (await companyFilms(from.company, from.minVotes ?? 300)) ?? [], art: null, source: `company ${from.company}` };
  }
  const name = from.director ?? from.actor;
  if (name) {
    const person = await findPerson(name);
    const list = person ? await credits(person.id) : null;
    if (!list) return { ids: [], art: null, source: `${name}: not found` };
    const ids = from.director
      ? pickCredits(list.crew.filter((credit) => credit.job === "Director"), {
          minVotes: from.minVotes ?? DIRECTOR_MIN_VOTES,
          top: from.top,
        })
      : pickCredits(
          list.cast.filter(
            (credit) => (credit.order ?? 99) <= LEAD_ORDER && !/\bhimself\b|\bherself\b|uncredited/i.test(credit.character ?? ""),
          ),
          { minVotes: from.minVotes ?? ACTOR_MIN_VOTES, top: from.top },
        );
    return {
      ids,
      art: person.photo ? { photo: `https://image.tmdb.org/t/p/h632${person.photo}` } : null,
      source: person.name,
    };
  }
  return { ids: [], art: null, source: "no `from`" };
};

// Rank thresholds as film counts: `at` a count (or "all"), `share` a part of
// the whole. Rising, one per count — a smaller saga keeps its higher ranks.
const resolveRanks = (ranks, total) => {
  const counts = ranks.map((rank) => ({
    title: rank.title,
    at:
      rank.at === "all"
        ? total
        : rank.share != null
          ? Math.max(1, Math.ceil(rank.share * total))
          : Math.min(rank.at, total),
  }));
  return counts.filter(
    (rank, i) => counts.slice(i + 1).every((later) => later.at > rank.at) && (i === 0 || rank.at > 0),
  );
};

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
for (const { saga, ids, art, source } of resolvedSagas) {
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
    art: art ?? (fallback ? { backdrop: fallback } : null),
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
