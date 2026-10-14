// Refreshes cast, details and IMDb ratings in data/catalog.json from OMDb
// (https://www.omdbapi.com). A one-off enrichment you run by hand — the
// server never calls OMDb itself. Restart the server afterwards to load it.
//
//   npm run enrich-omdb            (reads OMDB_API_KEY from .env)
//   OMDB_API_KEY=yourkey npm run enrich-omdb
//   PowerShell:  $env:OMDB_API_KEY="yourkey"; npm run enrich-omdb
//
// Safe to re-run: a movie OMDb can't find this time keeps what it had.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "catalog.json");
const CAST_PER_MOVIE = 4;
const DELAY_MS = 120;

const API_KEY = process.env.OMDB_API_KEY;
if (!API_KEY) {
  console.error("Set OMDB_API_KEY first (see the top of this file).");
  process.exit(1);
}

// Titles OMDb can't match by title + year (listed a year off, or under a
// different title — "Seven", "WALL·E"), looked up by IMDb id instead.
const IMDB_IDS = {
  "The Deer Hunter|1978": "tt0077416",
  "Schindler's List|1993": "tt0108052",
  "Se7en|1995": "tt0114369",
  "Memento|2000": "tt0209144",
  "WALL-E|2008": "tt0910970",
  "Amelie|2001": "tt0211915",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// OMDb sends some text HTML-escaped ("O&apos;Connor").
const ENTITIES = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " " };
const decode = (text) =>
  text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
    return String.fromCodePoint(
      code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10),
    );
  });
const clean = (value) => (value && value !== "N/A" ? decode(value.trim()) : null);

const fetchOmdb = async (movie) => {
  const imdbId = movie.details?.imdbId ?? IMDB_IDS[`${movie.title}|${movie.year}`];
  const query = new URLSearchParams(
    imdbId
      ? { apikey: API_KEY, i: imdbId }
      : { apikey: API_KEY, t: movie.title, y: String(movie.year), type: "movie" },
  );
  let data = await (await fetch(`https://www.omdbapi.com/?${query}`)).json();
  // A few titles are listed a year off on OMDb — retry without the year.
  if (data.Response !== "True" && !imdbId) {
    query.delete("y");
    data = await (await fetch(`https://www.omdbapi.com/?${query}`)).json();
  }
  return data.Response === "True" ? data : null;
};

const toDetails = (data) => {
  const rating = (source) =>
    clean(data.Ratings?.find((entry) => entry.Source === source)?.Value);
  const rottenTomatoes = rating("Rotten Tomatoes");
  const metacritic = rating("Metacritic");
  return {
    imdbId: clean(data.imdbID),
    imdbRating: clean(data.imdbRating) ? parseFloat(data.imdbRating) : null,
    rated: clean(data.Rated),
    language: clean(data.Language),
    country: clean(data.Country),
    writers: clean(data.Writer),
    awards: clean(data.Awards),
    boxOffice: clean(data.BoxOffice),
    // "89%" → 89, "82/100" → 82
    rottenTomatoes: rottenTomatoes ? parseInt(rottenTomatoes, 10) : null,
    metacritic: metacritic ? parseInt(metacritic, 10) : null,
  };
};

const toCast = (data) =>
  clean(data.Actors)
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, CAST_PER_MOVIE) ?? null;

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const missing = [];
let updated = 0;

for (const movie of catalog.movies) {
  try {
    const data = await fetchOmdb(movie);
    if (data) {
      movie.details = toDetails(data);
      movie.cast = toCast(data) ?? movie.cast;
      // The real IMDb score wins over whatever rating the movie had.
      if (movie.details.imdbRating) movie.rating = movie.details.imdbRating;
      updated += 1;
    } else {
      missing.push(`${movie.title} (${movie.year})`);
    }
  } catch (error) {
    missing.push(`${movie.title} (${movie.year}) — ${error.message}`);
  }
  process.stdout.write(".");
  await sleep(DELAY_MS);
}
process.stdout.write("\n");

fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
console.log(`Updated ${updated}/${catalog.movies.length} movies in data/catalog.json.`);
if (missing.length > 0) {
  console.log(`Not found on OMDb (kept as they were): ${missing.length}`);
  missing.forEach((line) => console.log(`  - ${line}`));
}
