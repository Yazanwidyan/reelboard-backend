import { HttpError } from "./errors.js";

// A small client for TMDB's API (https://developer.themoviedb.org). The
// token stays on this server — the app never sees it — and answers are
// kept for a while in memory, so popular movies and lists don't cost a
// request each time someone opens them.
//
// Reads TMDB_READ_TOKEN (preferred) or TMDB_API_KEY, and TMDB_API_URL (the
// tests point it at a fake TMDB) when each request is made.

export const IMAGE_BASE = "https://image.tmdb.org/t/p";

const MAX_IN_FLIGHT = 10;
const MAX_CACHED = 3000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export const tmdbConfigured = () =>
  Boolean(process.env.TMDB_READ_TOKEN || process.env.TMDB_API_KEY);

const unavailable = () =>
  new HttpError(503, "The movie database isn't reachable right now — try again in a moment");

// Answers by URL: { value, expires }. Map order doubles as least-recently-used.
const cache = new Map();
const remember = (key, value, ttl) => {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
};
const recall = (key) => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};
export const clearTmdbCache = () => cache.clear();

// At most MAX_IN_FLIGHT requests at once; the rest wait their turn.
let inFlight = 0;
const waiting = [];
const slot = async () => {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight += 1;
};
const release = () => {
  inFlight -= 1;
  waiting.shift()?.();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET a TMDB path. Resolves to the JSON, or null for a 404. Same request
// within `ttl` is answered from memory (and concurrent ones share one).
const pending = new Map();
export const tmdbGet = async (pathname, params = {}, { ttl = DEFAULT_TTL_MS } = {}) => {
  if (!tmdbConfigured()) throw unavailable();
  const url = new URL((process.env.TMDB_API_URL ?? "https://api.themoviedb.org/3") + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const key = url.toString();
  const cached = recall(key);
  if (cached !== undefined) return cached;
  if (pending.has(key)) return pending.get(key);

  const request = (async () => {
    const token = process.env.TMDB_READ_TOKEN;
    if (!token) url.searchParams.set("api_key", process.env.TMDB_API_KEY);
    await slot();
    try {
      for (let attempt = 0; ; attempt += 1) {
        let response;
        try {
          response = await fetch(url, {
            headers: {
              accept: "application/json",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          throw unavailable();
        }
        if (response.status === 429 && attempt < 3) {
          await sleep(1000 * Number(response.headers.get("retry-after") ?? 2 ** attempt));
          continue;
        }
        if (response.status === 404) {
          remember(key, null, ttl);
          return null;
        }
        if (!response.ok) throw unavailable();
        const data = await response.json();
        remember(key, data, ttl);
        return data;
      }
    } finally {
      release();
    }
  })();
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
};

export const imageUrl = (path, size) => (path ? `${IMAGE_BASE}/${size}${path}` : null);
