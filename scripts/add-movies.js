// Grows data/catalog.json with the movies listed in data/seed-movies.txt,
// looked up on OMDb (https://www.omdbapi.com). Also applies the franchise
// tags in that list to movies already in the catalog.
//
//   npm run add-movies            (reads OMDB_API_KEY from .env)
//   npm run add-movies -- --limit 10   (try just the first 10 new ones)
//   npm run add-movies -- --offline    (no OMDb requests, cached answers only)
//
// A line can pin the exact film with its IMDb id as a 4th column
// (Title|Year|Franchise|tt0000000) when the title alone is ambiguous.
//
// Every OMDb answer is kept in data/omdb-cache.json, so re-running never
// asks twice; if OMDb's daily limit is hit it saves what it has and stops —
// run it again the next day to carry on. Restart the server afterwards.
//
// Vibes (the six Taste DNA scores) for new movies are estimated by a small
// model learnt from the hand-tagged movies already in the catalog — ridge
// regression from genres, runtime, rating, era and plot words — and marked
// `vibeSource: "estimated"` so they can be hand-tuned later.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(ROOT, "data", "catalog.json");
const SEEDS = path.join(ROOT, "data", "seed-movies.txt");
const CACHE = path.join(ROOT, "data", "omdb-cache.json");
const DELAY_MS = 120;
const CAST_PER_MOVIE = 4;
const MIN_RUNTIME = 40;
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
// --offline: only use answers already in the cache (no OMDb requests).
const OFFLINE = process.argv.includes("--offline");

const API_KEY = process.env.OMDB_API_KEY;
if (!API_KEY) {
  console.error("Set OMDB_API_KEY first (in .env).");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1) + "\n");

const normalize = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const keyOf = (title, year) => `${normalize(title)}|${year}`;
// "1,234,567" → 1234567 (how many people rated it on IMDb).
const votesOf = (data) => {
  const votes = parseInt(String(data.imdbVotes ?? "").replace(/,/g, ""), 10);
  return Number.isNaN(votes) ? null : votes;
};

// ---- Seeds --------------------------------------------------------------------

const seeds = [];
for (const line of fs.readFileSync(SEEDS, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const [title, year, franchise, imdbId] = trimmed.split("|").map((part) => part?.trim());
  const key = keyOf(title, year);
  const existing = seeds.find((seed) => seed.key === key);
  if (existing) {
    existing.franchise ??= franchise || null;
    existing.imdbId ??= imdbId || null;
    continue;
  }
  seeds.push({ title, year: Number(year), franchise: franchise || null, imdbId: imdbId || null, key });
}

// ---- Existing movies: franchise tags -------------------------------------------

const byKey = new Map(catalog.movies.map((movie) => [keyOf(movie.title, movie.year), movie]));
const byImdb = new Map(
  catalog.movies.filter((movie) => movie.details?.imdbId).map((movie) => [movie.details.imdbId, movie]),
);
let tagged = 0;
for (const seed of seeds) {
  const movie = byKey.get(seed.key);
  if (movie && seed.franchise && movie.franchise !== seed.franchise) {
    movie.franchise = seed.franchise;
    tagged += 1;
  }
}
// The original 250 were tagged by hand.
catalog.movies.forEach((movie) => {
  movie.vibeSource ??= "hand";
});

// ---- OMDb ---------------------------------------------------------------------------

class LimitReached extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;

const omdb = async (params) => {
  requests += 1;
  const query = new URLSearchParams({ apikey: API_KEY, type: "movie", plot: "short", ...params });
  const data = await (await fetch(`https://www.omdbapi.com/?${query}`)).json();
  await sleep(DELAY_MS);
  if (data.Error && /limit/i.test(data.Error)) throw new LimitReached(data.Error);
  return data.Response === "True" ? data : null;
};

// A pinned IMDb id (4th column) is looked up directly. Otherwise title +
// year first; a few films are listed a year off, so then the title alone.
const cacheKeyOf = (seed) => (seed.imdbId ? `imdb:${seed.imdbId}` : seed.key);

const lookUp = async (seed) => {
  // An earlier title search that found the pinned film needs no new request.
  const searched = cache[seed.key];
  if (seed.imdbId && searched?.imdbID === seed.imdbId) return searched;
  const cacheKey = cacheKeyOf(seed);
  if (cache[cacheKey] !== undefined) return cache[cacheKey];
  if (OFFLINE) return null;
  let data;
  if (seed.imdbId) {
    data = await omdb({ i: seed.imdbId });
  } else {
    data = await omdb({ t: seed.title, y: String(seed.year) });
    if (!data) data = await omdb({ t: seed.title });
  }
  cache[cacheKey] = data ?? { missing: true };
  return cache[cacheKey];
};

// OMDb's title search is loose — "Traffic" can come back as "Human Traffic",
// "Munich" as "Munich Mambo". A search answer only counts if it's the same
// title (or that title plus a subtitle, "Lagaan: Once Upon a Time in
// India") within a year. A pinned id is trusted if its year is close or its
// title matches — OMDb often lists a film's later US release year.
const titleMatches = (wanted, found) => {
  const a = normalize(wanted).replace(/^(the|a|an) /, "");
  const b = normalize(found).replace(/^(the|a|an) /, "");
  if (a === b) return true;
  const raw = String(found).toLowerCase();
  const prefix = String(wanted).toLowerCase();
  return raw.startsWith(`${prefix}:`) || raw.startsWith(`${prefix} -`);
};

const yearGap = (seed, data) => Math.abs(parseInt(data.Year, 10) - seed.year);
const searchAccepts = (seed, data) =>
  Boolean(data) && !data.missing && yearGap(seed, data) <= 1 && titleMatches(seed.title, data.Title);
const pinAccepts = (seed, data) =>
  Boolean(data) && !data.missing && (yearGap(seed, data) <= 2 || titleMatches(seed.title, data.Title));
const accepts = (seed, data) =>
  seed.imdbId ? data.imdbID === seed.imdbId && pinAccepts(seed, data) : searchAccepts(seed, data);

// Re-check movies added by earlier runs with today's rules: one that no
// seed in the list accepts any more (a wrong match) is taken out again.
const removed = [];
{
  // Either the pinned lookup or the earlier title search can vouch for it.
  const acceptedBy = new Map();
  for (const seed of seeds) {
    const pinned = seed.imdbId ? cache[`imdb:${seed.imdbId}`] : null;
    const searched = cache[seed.key];
    if (pinned && pinAccepts(seed, pinned)) acceptedBy.set(pinned.imdbID, seed);
    // With a pin, a search answer only counts if it found the pinned film
    // (same name and year isn't enough — that's why it's pinned).
    if (searched && searchAccepts(seed, searched) && (!seed.imdbId || searched.imdbID === seed.imdbId)) {
      acceptedBy.set(searched.imdbID, seed);
    }
  }
  catalog.movies = catalog.movies.filter((movie) => {
    if (movie.vibeSource !== "estimated") return true;
    const seed = acceptedBy.get(movie.details?.imdbId);
    if (seed) {
      // The list's year is the original release; OMDb's is often later.
      movie.year = seed.year;
      const pinned = seed.imdbId ? cache[`imdb:${seed.imdbId}`] : null;
      const data = pinned?.imdbID === movie.details.imdbId ? pinned : cache[seed.key];
      if (data && movie.details.imdbVotes == null) movie.details.imdbVotes = votesOf(data);
      return true;
    }
    removed.push(`${movie.title} (${movie.year})`);
    byImdb.delete(movie.details?.imdbId);
    byKey.delete(keyOf(movie.title, movie.year));
    return false;
  });
}

// ---- Turning an OMDb answer into a catalog movie ----------------------------------

const CATALOG_GENRES = new Set(catalog.movies.flatMap((movie) => movie.genres));
// OMDb genres the catalog doesn't use become themes instead.
const GENRE_THEMES = {
  War: "war",
  Biography: "true",
  History: "true",
  Music: "music",
  Musical: "music",
  Sport: "sports",
  Western: "western",
  "Film-Noir": "noir",
  Family: "family",
};

const clean = (value) => (value && value !== "N/A" ? value.trim() : null);
const ENTITIES = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">" };
const decode = (text) =>
  text?.replace(/&(#\d+|[a-z]+);/gi, (match, code) =>
    code[0] === "#" ? String.fromCodePoint(Number(code.slice(1))) : (ENTITIES[code] ?? match),
  ) ?? null;

const PLOT_THEMES = [
  ["heist", /\b(heist|robbery|rob|steal|con artist|swindle)\b/],
  ["revenge", /\b(revenge|vengeance|avenge)/],
  ["coming-of-age", /\b(teen|teenage|adolescen|high school|coming of age|growing up)\b/],
  ["friendship", /\bfriend(s|ship)?\b/],
  ["love", /\b(love|romance|falls for|marriage|wedding)\b/],
  ["family", /\b(family|father|mother|son|daughter|siblings?|brother|sister)\b/],
  ["true", /\b(true story|real-life|based on)\b/],
  ["crime", /\b(gangster|mob|mafia|cartel|drug lord|criminal)\b/],
  ["killer", /\b(serial killer|murderer|killer|slasher)\b/],
  ["detective", /\b(detective|investigat|inspector|cop)\w*/],
  ["supernatural", /\b(ghost|demon|haunt|possess|witch|curse|spirit)\w*/],
  ["monster", /\b(monster|creature|beast|shark|dinosaur|kaiju)\w*/],
  ["survival", /\b(surviv|stranded|trapped)\w*/],
  ["space", /\b(space|planet|astronaut|galaxy|mars)\b/],
  ["ai", /\b(robot|artificial intelligence|android|cyborg)\w*/],
  ["time", /\b(time travel|time loop|the past|the future)\b/],
  ["dystopia", /\b(dystopia|totalitarian|post-apocalyptic|apocalypse)\w*/],
  ["chase", /\b(chase|on the run|pursu)\w*/],
  ["spy", /\b(spy|agent|cia|mi6|espionage)\b/],
  ["superhero", /\b(superhero|super-hero|super powers|avengers|mutant)\w*/],
  ["quest", /\b(quest|journey|adventure)\b/],
  ["fairy-tale", /\b(princess|fairy|kingdom|magic)\w*/],
  ["sports", /\b(boxer|team|champion|coach|football|baseball|basketball)\b/],
  ["school", /\b(school|teacher|student|college)\b/],
  ["prison", /\b(prison|inmate|jail)\b/],
  ["aliens", /\b(alien|extraterrestrial)\w*/],
  ["road", /\broad trip\b/],
  ["conspiracy", /\b(conspiracy|cover-up)\b/],
  ["showbiz", /\b(hollywood|actor|actress|film industry|stardom)\b/],
  ["dreams", /\b(dream|memor(y|ies)|mind)\b/],
  ["grief", /\b(grief|grieving|death of|loss of)\b/],
  ["obsession", /\bobsess\w*/],
];

const themesFor = (rawGenres, plot) => {
  const text = normalize(plot);
  const themes = [];
  rawGenres.forEach((genre) => {
    const theme = GENRE_THEMES[genre];
    if (theme && !themes.includes(theme)) themes.push(theme);
  });
  if (rawGenres.includes("Crime") && !themes.includes("crime")) themes.push("crime");
  for (const [theme, pattern] of PLOT_THEMES) {
    if (themes.length >= 3) break;
    if (pattern.test(text) && !themes.includes(theme) && catalog.themes[theme]) themes.push(theme);
  }
  return themes.slice(0, 3);
};

// ---- The vibe model -----------------------------------------------------------------

const DIMS = catalog.dimensions.map((dimension) => dimension.key);
const GENRE_LIST = [...CATALOG_GENRES].sort();
const KEYWORDS = [
  /\b(murder|kill|death|dead|war)\w*/,
  /\b(love|romance|wedding)\b/,
  /\b(family|friend)\w*/,
  /\b(dream|memory|mind|reality|time)\b/,
  /\b(world|empire|galaxy|kingdom|planet)\b/,
  /\b(magic|ghost|demon|alien|monster|robot)\w*/,
  /\b(chase|escape|race|fight|battle)\w*/,
];

const features = (movie, extraGenres = []) => {
  const text = normalize(movie.description);
  const rated = movie.details?.rated ?? "";
  return [
    1,
    ...GENRE_LIST.map((genre) => (movie.genres.includes(genre) ? 1 : 0)),
    (movie.runtime - 120) / 30,
    (movie.year - 1990) / 30,
    (movie.rating - 7.5) / 1,
    /^R|NC-17/.test(rated) ? 1 : 0,
    /^G|PG$/.test(rated) ? 1 : 0,
    extraGenres.includes("War") ? 1 : 0,
    extraGenres.some((g) => g === "Biography" || g === "History") ? 1 : 0,
    extraGenres.includes("Family") ? 1 : 0,
    ...KEYWORDS.map((pattern) => (pattern.test(text) ? 1 : 0)),
  ];
};

// Ridge regression: solve (XᵀX + λI) w = Xᵀy.
const fit = (rows, targets, lambda = 1) => {
  const p = rows[0].length;
  const a = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      rows.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? lambda : 0),
    ),
  );
  const b = Array.from({ length: p }, (_, i) =>
    rows.reduce((sum, row, n) => sum + row[i] * targets[n], 0),
  );
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < p; r += 1) {
      if (r === col || a[col][col] === 0) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c < p; c += 1) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }
  return b.map((value, i) => (a[i][i] === 0 ? 0 : value / a[i][i]));
};

const predict = (weights, row) => row.reduce((sum, value, i) => sum + value * weights[i], 0);
const toScore = (value) => Math.max(1, Math.min(5, Math.round(value)));

const training = catalog.movies.filter((movie) => movie.vibeSource === "hand" && movie.vibe?.dims);
const trainRows = training.map((movie) => features(movie));
const models = DIMS.map((_, d) => fit(trainRows, training.map((movie) => movie.vibe.dims[d])));

// How good the estimate is: train on 80%, score the other 20%.
const holdout = training.filter((_, i) => i % 5 === 0);
const rest = training.filter((_, i) => i % 5 !== 0);
const checkModels = DIMS.map((_, d) =>
  fit(rest.map((movie) => features(movie)), rest.map((movie) => movie.vibe.dims[d])),
);
const meanError = (pick) =>
  (holdout.reduce((sum, movie) => sum + DIMS.reduce((s, _, d) => s + Math.abs(pick(movie, d) - movie.vibe.dims[d]), 0), 0) /
    (holdout.length * DIMS.length)).toFixed(2);
const average = DIMS.map((_, d) => rest.reduce((s, m) => s + m.vibe.dims[d], 0) / rest.length);
console.log(
  `Vibe model: off by ${meanError((movie, d) => toScore(predict(checkModels[d], features(movie))))} points on average ` +
    `(1–5 scale) on held-out hand-tagged movies — vs ${meanError((_, d) => toScore(average[d]))} for always guessing the average.`,
);

// ---- Run ------------------------------------------------------------------------------

const toMovie = (data, seed, id, rank) => {
  const rawGenres = (clean(data.Genre) ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  let genres = rawGenres.filter((genre) => CATALOG_GENRES.has(genre));
  if (genres.length === 0) genres = ["Drama"];
  const rating = (source) => clean(data.Ratings?.find((entry) => entry.Source === source)?.Value);
  const movie = {
    id,
    rank,
    title: decode(clean(data.Title)) ?? seed.title,
    // The list's year: the original release (OMDb often has the US one).
    year: seed.year,
    rating: parseFloat(data.imdbRating),
    runtime: parseInt(data.Runtime, 10),
    genres,
    director: decode(clean(data.Director)?.split(",")[0].trim()) ?? null,
    cast: (clean(data.Actors) ?? "").split(",").map((name) => decode(name.trim())).filter(Boolean).slice(0, CAST_PER_MOVIE),
    details: {
      imdbId: clean(data.imdbID),
      imdbRating: parseFloat(data.imdbRating),
      // How many people rated it — how well known it is ("Hidden gems").
      imdbVotes: votesOf(data),
      rated: clean(data.Rated),
      language: clean(data.Language),
      country: clean(data.Country),
      writers: decode(clean(data.Writer)),
      awards: clean(data.Awards),
      boxOffice: clean(data.BoxOffice),
      rottenTomatoes: rating("Rotten Tomatoes") ? parseInt(rating("Rotten Tomatoes"), 10) : null,
      metacritic: rating("Metacritic") ? parseInt(rating("Metacritic"), 10) : null,
    },
    description: decode(clean(data.Plot)) ?? "",
    franchise: seed.franchise,
    poster: clean(data.Poster),
    backdrop: `https://picsum.photos/seed/board-${id}-bg/1280/720`,
  };
  const row = features(movie, rawGenres);
  movie.vibe = {
    dims: DIMS.map((_, d) => toScore(predict(models[d], row))),
    themes: themesFor(rawGenres, movie.description),
  };
  movie.vibeSource = "estimated";
  return movie;
};

const skipped = [];
let added = 0;
let nextNumber = Math.max(...catalog.movies.map((movie) => Number(movie.id.slice(1)))) + 1;
let nextRank = Math.max(...catalog.movies.map((movie) => movie.rank)) + 1;
let stoppedEarly = false;

try {
  let looked = 0;
  for (const seed of seeds) {
    if (byKey.has(seed.key)) continue;
    if (looked >= LIMIT) break;
    looked += 1;
    const data = await lookUp(seed);
    if (!data) continue; // --offline and not cached yet
    if (data.missing) {
      skipped.push(`${seed.title} (${seed.year}) — not found on OMDb`);
      continue;
    }
    if (!accepts(seed, data)) {
      skipped.push(`${seed.title} (${seed.year}) — OMDb found "${data.Title}" (${data.Year}) instead; pin its IMDb id`);
      continue;
    }
    if (byImdb.has(data.imdbID)) continue; // listed under another title
    const runtime = parseInt(data.Runtime, 10);
    const reason = !clean(data.Poster)
      ? "no poster"
      : Number.isNaN(parseFloat(data.imdbRating))
        ? "no IMDb rating yet"
        : !(runtime >= MIN_RUNTIME)
          ? "too short / no runtime"
          : /Documentary/.test(data.Genre)
            ? "documentary"
            : null;
    if (reason) {
      skipped.push(`${seed.title} (${seed.year}) — ${reason}`);
      continue;
    }
    const movie = toMovie(data, seed, `m${nextNumber}`, nextRank);
    nextNumber += 1;
    nextRank += 1;
    catalog.movies.push(movie);
    byKey.set(seed.key, movie);
    byImdb.set(data.imdbID, movie);
    added += 1;
    if (added % 25 === 0) process.stdout.write(`  ${added} added…\n`);
  }
} catch (error) {
  if (!(error instanceof LimitReached)) throw error;
  stoppedEarly = true;
  console.log(`OMDb's daily limit reached (${error.message}) — run again tomorrow to continue.`);
} finally {
  // Rank stays "best first": the original 250 keep theirs, the rest follow
  // by IMDb's weighted rating — a rating from few voters is pulled toward
  // the average (an 8.8 from 35 people shouldn't outrank an 8.5 from a
  // million). Collections' "Best of" lists pick by rank.
  const added = catalog.movies.filter((movie) => movie.vibeSource === "estimated");
  const meanRating = added.reduce((sum, movie) => sum + movie.rating, 0) / (added.length || 1);
  const MIN_VOTES = 25000;
  const weighted = (movie) => {
    const votes = movie.details?.imdbVotes ?? 0;
    return (votes / (votes + MIN_VOTES)) * movie.rating + (MIN_VOTES / (votes + MIN_VOTES)) * meanRating;
  };
  const lastOriginal = Math.max(
    ...catalog.movies.filter((movie) => movie.vibeSource !== "estimated").map((movie) => movie.rank),
  );
  added
    .sort((a, b) => weighted(b) - weighted(a))
    .forEach((movie, i) => {
      movie.rank = lastOriginal + 1 + i;
    });
  catalog.movies.sort((a, b) => a.rank - b.rank);
  saveCache();
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
}

if (removed.length > 0) {
  console.log(`Removed ${removed.length} earlier wrong match(es): ${removed.join("; ")}`);
}
console.log(
  `${added} movies added (catalog now ${catalog.movies.length}), ${tagged} franchise tags set, ` +
    `${requests} OMDb requests${stoppedEarly ? " — stopped early" : ""}.`,
);
if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length}:`);
  skipped.forEach((line) => console.log(`  - ${line}`));
}
