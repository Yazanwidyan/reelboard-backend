import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { all, closeDatabase, get, openDatabase, run, writePool, writeSagas } from "../src/db/index.js";
import { pushTransport } from "../src/lib/push.js";
import { titleName, titleStepFor } from "../src/lib/titles.js";
import { pruneActivity } from "../src/lib/activity.js";
import { verifiers } from "../src/lib/social.js";
import fs from "node:fs";
import zlib from "node:zlib";
import { FAKE_COLLECTION_ID, FAKE_MOVIE_ID, FAKE_PERSON_ID, startFakeTmdb } from "./fakeTmdb.js";

// The pool for the tests: the curated movies, as build-pool makes them
// (without the movie-page extras). The real pool is built from TMDB.
const POOL = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/pool.json.gz", import.meta.url))).toString("utf8"),
);
const CATALOG_SIZE = POOL.length;
// Two sagas for the tests, as build-pool resolves them (the real ones come
// from data/curation.json and TMDB).
const SAGAS = [
  {
    id: "saga-gothams-guardian",
    type: "saga",
    kind: "franchise",
    title: "Gotham's Guardian",
    subtitle: "The Dark Knight trilogy",
    movieIds: ["272", "155", "49026"],
    ranks: [
      { title: "Citizen", at: 1 },
      { title: "Detective", at: 2 },
      { title: "Gotham's Guardian", at: 3 },
    ],
    art: { backdrop: "https://image.tmdb.org/t/p/w1280/gotham.jpg" },
  },
  {
    id: "saga-mind-bender",
    type: "saga",
    kind: "director",
    title: "Mind-Bender",
    subtitle: "Christopher Nolan's films",
    movieIds: ["77", "1124", "155", "27205", "157336"],
    ranks: [
      { title: "Dreamer", at: 2 },
      { title: "Architect", at: 4 },
      { title: "Mind-Bender", at: 5 },
    ],
    art: { photo: "https://image.tmdb.org/t/p/h632/nolan.jpg" },
  },
];

let server;
let base;
let tmdb;

before(async () => {
  // A fake TMDB (test/fakeTmdb.js): the pool comes from the fixture,
  // anything else from here.
  tmdb = await startFakeTmdb();
  process.env.TMDB_API_URL = tmdb.url;
  process.env.TMDB_READ_TOKEN = "test-token";
  delete process.env.TMDB_API_KEY;
  openDatabase(":memory:");
  writePool(POOL);
  writeSagas(SAGAS);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  tmdb.close();
  closeDatabase();
});

const api = async (method, path, { token, body, headers } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

const register = async (name, handle) => {
  const { status, body } = await api("POST", "/auth/register", {
    body: { email: `${handle}@example.com`, password: "password123", displayName: name, handle },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
};

describe("auth", () => {
  test("register, login, refresh, and reject bad input", async () => {
    const { token, user } = await register("Auth Person", "authperson");
    assert.ok(token);
    assert.equal(user.handle, "@authperson");
    assert.equal(user.displayName, "Auth Person");

    const dup = await api("POST", "/auth/register", {
      body: { email: "AUTHPERSON@example.com", password: "password123", displayName: "X" },
    });
    assert.equal(dup.status, 409);

    const bad = await api("POST", "/auth/register", {
      body: { email: "nope", password: "short", displayName: "" },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.length >= 3);

    const wrong = await api("POST", "/auth/login", {
      body: { email: "authperson@example.com", password: "wrong-password" },
    });
    assert.equal(wrong.status, 401);

    const login = await api("POST", "/auth/login", {
      body: { email: "authperson@example.com", password: "password123" },
    });
    assert.equal(login.status, 200);

    const refreshed = await api("POST", "/auth/refresh", { token: login.body.token });
    assert.equal(refreshed.status, 200);

    assert.equal((await api("GET", "/me")).status, 401);
    assert.equal((await api("GET", "/me", { token: "garbage" })).status, 401);
  });

  test("handles are derived from the email and made unique", async () => {
    const a = await api("POST", "/auth/register", {
      body: { email: "same.name@a.com", password: "password123", displayName: "A" },
    });
    const b = await api("POST", "/auth/register", {
      body: { email: "same.name@b.com", password: "password123", displayName: "B" },
    });
    assert.equal(a.body.user.handle, "@same.name");
    assert.equal(b.body.user.handle, "@same.name2");
  });
});

describe("google and apple sign-in", () => {
  // Real Google/Apple tokens can't be minted in a test; the verifiers are
  // swapped for fakes that read the "token" as JSON claims.
  const realVerifiers = { ...verifiers };
  const fakeToken = (claims) => JSON.stringify(claims);
  before(() => {
    verifiers.google = async (token) => ({ name: null, ...JSON.parse(token) });
    verifiers.apple = async (token) => ({ name: null, ...JSON.parse(token) });
  });
  after(() => Object.assign(verifiers, realVerifiers));

  test("refuses when the server has no Google client id configured", async () => {
    const r = await realVerifiers.google("x").catch((error) => error);
    assert.equal(r.status, 503);
  });

  test("first sign-in creates an account; later ones find it", async () => {
    const token = fakeToken({ subject: "g-1", email: "Gina@Example.com", emailVerified: true, name: "Gina G" });
    const first = await api("POST", "/auth/google", { body: { idToken: token } });
    assert.equal(first.status, 201);
    assert.equal(first.body.isNew, true);
    assert.equal(first.body.user.displayName, "Gina G");
    assert.equal(first.body.user.email, "gina@example.com");
    assert.equal(first.body.user.hasPassword, false);

    const again = await api("POST", "/auth/google", { body: { idToken: token } });
    assert.equal(again.status, 200);
    assert.equal(again.body.isNew, false);
    assert.equal(again.body.user.id, first.body.user.id);

    const me = await api("GET", "/me", { token: again.body.token });
    assert.equal(me.status, 200);

    // No password to log in with — the message says what to do instead.
    const login = await api("POST", "/auth/login", { body: { email: "gina@example.com", password: "whatever1" } });
    assert.equal(login.status, 401);
    assert.match(login.body.error.message, /Google or Apple/);
  });

  test("a verified email links to the existing account; an unverified one doesn't", async () => {
    const owner = await register("Email Owner", "emailowner");
    const linked = await api("POST", "/auth/apple", {
      body: { identityToken: fakeToken({ subject: "a-1", email: "emailowner@example.com", emailVerified: true }) },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.user.id, owner.user.id);
    assert.equal(linked.body.user.hasPassword, true);

    const sneaky = await api("POST", "/auth/google", {
      body: { idToken: fakeToken({ subject: "g-2", email: "emailowner@example.com", emailVerified: false }) },
    });
    assert.equal(sneaky.status, 409);
  });

  test("apple without an email still gets an account, named from the app", async () => {
    const r = await api("POST", "/auth/apple", {
      body: { identityToken: fakeToken({ subject: "a-2", email: null, emailVerified: false }), fullName: "Ali A" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.displayName, "Ali A");
  });

  test("deleting a google-only account asks for DELETE instead of a password", async () => {
    const r = await api("POST", "/auth/google", {
      body: { idToken: fakeToken({ subject: "g-3", email: "leaving@example.com", emailVerified: true }) },
    });
    const { token } = r.body;
    assert.equal((await api("DELETE", "/me", { token, body: {} })).status, 400);
    assert.equal((await api("DELETE", "/me", { token, body: { confirm: "DELETE" } })).status, 204);
    // Signing in again starts a fresh account.
    const back = await api("POST", "/auth/google", {
      body: { idToken: fakeToken({ subject: "g-3", email: "leaving@example.com", emailVerified: true }) },
    });
    assert.equal(back.body.isNew, true);
  });
});

describe("movies", () => {
  test("list, filter, search, fetch one, meta, reels", async () => {
    const all = await api("GET", "/movies?limit=250");
    assert.equal(all.body.total, CATALOG_SIZE);
    assert.equal(all.body.movies[0].id, "289");

    const filtered = await api("GET", "/movies?genres=Animation&decade=2010s&limit=100");
    assert.ok(filtered.body.total > 0);
    for (const movie of filtered.body.movies) {
      assert.ok(movie.genres.includes("Animation"));
      assert.ok(movie.year >= 2010 && movie.year <= 2019);
    }

    const search = await api("GET", "/movies?q=heath%20ledger");
    assert.ok(search.body.movies.some((movie) => movie.title === "The Dark Knight"));

    const byRating = await api("GET", "/movies?sort=rating&limit=5");
    const ratings = byRating.body.movies.map((movie) => movie.rating);
    assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));

    const ids = await api("GET", "/movies?ids=872,289,15");
    assert.deepEqual(ids.body.movies.map((movie) => movie.id), ["872", "289", "15"]);

    const { token } = await register("Movie Fan", "moviefan");
    assert.equal((await api("GET", "/movies/289")).status, 401, "a movie's page needs signing in");
    const one = await api("GET", "/movies/289", { token });
    assert.equal(one.body.movie.title, "Casablanca");
    assert.equal(one.body.movie.vibe.dims.length, 6);
    assert.equal((await api("GET", "/movies/999999999", { token })).status, 404);

    const meta = await api("GET", "/movies/meta");
    assert.ok(meta.body.genres.includes("Drama"));
    assert.equal(meta.body.dimensions.length, 6);

    const reels = await api("GET", "/movies/reels");
    assert.ok(reels.body.clips.length > 0);
    assert.deepEqual(Object.keys(reels.body.clips[0]).sort(), ["end", "movieId", "start", "youtubeId"]);
    const reelIds = new Set(reels.body.movies.map((movie) => movie.id));
    assert.ok(reels.body.clips.every((clip) => reelIds.has(clip.movieId)));

    assert.equal((await api("GET", "/movies?decade=1850s")).status, 400);

    // The app no longer downloads the pool.
    assert.notEqual((await api("GET", "/movies/catalog", { token })).status, 200);
  });
});

// Christopher Nolan films in the pool, by TMDB id.
const NOLAN = { darkKnight: "155", inception: "27205", interstellar: "157336", prestige: "1124", memento: "77" };

describe("candidates", () => {
  let token;
  before(async () => {
    ({ token } = await register("Candid Person", "candid"));
  });

  test("a few hundred pool movies, full enough to swipe, none of them watched", async () => {
    const fresh = await api("GET", "/me/candidates", { token });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.movies.length, 300);
    assert.equal(fresh.body.relaxed, 0);
    const first = fresh.body.movies[0];
    assert.equal(first.vibe.dims.length, 6);
    assert.ok(first.poster && first.description !== undefined && Array.isArray(first.cast));
    assert.equal(first.details.castDetails, undefined, "the movie page's extras stay on the page");
    assert.equal(new Set(fresh.body.movies.map((movie) => movie.id)).size, 300);

    for (const movieId of [NOLAN.darkKnight, NOLAN.inception, NOLAN.interstellar]) {
      const r = await api("POST", "/me/watched", { token, body: { movieId, tier: "S" } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const after = await api("GET", "/me/candidates?count=100", { token });
    assert.equal(after.body.movies.length, 100);
    const ids = new Set(after.body.movies.map((movie) => movie.id));
    assert.ok(!ids.has(NOLAN.darkKnight) && !ids.has(NOLAN.inception));
    // Three Nolan films in S: his others rank near the top.
    assert.ok(ids.has(NOLAN.prestige), "The Prestige is picked for a Nolan fan");
  });

  test("filters narrow the whole pool, and loosen only when too few match", async () => {
    const horror = await api("GET", "/me/candidates?genres=Horror&count=50", { token });
    assert.equal(horror.body.relaxed, 0);
    assert.ok(horror.body.matching > 50, "counts every match, not just the ones sent");
    assert.ok(horror.body.movies.every((movie) => movie.genres.includes("Horror")));

    const nineties = await api("GET", "/me/candidates?decade=1990s&runtime=Under%202%20hours&count=50", { token });
    assert.ok(nineties.body.movies.every((movie) => movie.year >= 1990 && movie.year <= 1999 && movie.runtime < 120));

    // Too few 80s horrors for 300: all of them first, then the closest.
    const eighties = await api("GET", "/me/candidates?genres=Horror&decade=1980s", { token });
    assert.ok(eighties.body.relaxed > 0 && eighties.body.matching < 300);
    const isMatch = (movie) => movie.genres.includes("Horror") && movie.year >= 1980 && movie.year <= 1989;
    const firsts = eighties.body.movies.slice(0, eighties.body.matching);
    assert.ok(firsts.every(isMatch), "every exact match comes first");
    assert.equal(eighties.body.movies.filter(isMatch).length, eighties.body.matching, "and none is left out");

    const tooNarrow = await api("GET", "/me/candidates?genres=Western&decade=Older&minRating=9.5&count=50", { token });
    assert.ok(tooNarrow.body.relaxed > 0);
    assert.equal(tooNarrow.body.matching, 0);
    assert.equal(tooNarrow.body.movies.length, 50);

    assert.equal((await api("GET", "/me/candidates?decade=1850s", { token })).status, 400);
    assert.equal((await api("GET", "/me/candidates")).status, 401);
  });
});

describe("collections", () => {
  let token;
  before(async () => {
    ({ token } = await register("Collector", "collector"));
  });

  test("your library brings the sagas you've started, with cards for their films", async () => {
    await api("POST", "/me/watched", { token, body: { movieId: NOLAN.darkKnight } });
    let library = await api("GET", "/me/library", { token });
    assert.ok(library.body.movies.some((movie) => movie.id === NOLAN.darkKnight && movie.vibe));
    const ids = () => library.body.collections.map((collection) => collection.id);
    // One film starts a saga. Lists (a director's films, a franchise) are
    // for browsing — never "yours".
    assert.ok(ids().includes("saga-gothams-guardian"));
    assert.ok(ids().includes("saga-mind-bender"));
    assert.ok(!ids().some((id) => !id.startsWith("saga-")));
    const saga = library.body.collections.find((collection) => collection.id === "saga-mind-bender");
    assert.equal(saga.type, "saga");
    assert.equal(saga.kind, "director");
    assert.equal(saga.title, "Mind-Bender");
    assert.deepEqual(saga.ranks.map((rank) => rank.at), [2, 4, 5]);
    const byId = new Map(library.body.movies.map((movie) => [movie.id, movie]));
    // The watched ones in full; the rest as cards (no vibe), enough for a collage.
    const card = saga.movieIds.map((id) => byId.get(id)).find((movie) => movie?.partial);
    assert.ok(card && card.poster && card.title && !card.vibe);

    // Unlocked by hand: there even with nothing watched.
    await api("PUT", "/me/unlocked-collections/genre-best-of-horror", { token });
    library = await api("GET", "/me/library", { token });
    assert.ok(library.body.collections.some((collection) => collection.id === "genre-best-of-horror"));

    // GET /me carries the same.
    const me = await api("GET", "/me", { token });
    assert.ok(me.body.collections.some((collection) => collection.id === "saga-mind-bender"));
    assert.equal(me.body.bucketList, undefined);
  });

  test("featured: every saga; lists still open for browsing; a movie's own", async () => {
    const featured = await api("GET", "/collections", { token });
    assert.equal(featured.status, 200);
    assert.deepEqual(
      featured.body.collections.map((collection) => collection.id),
      SAGAS.map((saga) => saga.id),
    );
    assert.ok(featured.body.movies.length > 0);
    const etag = featured.headers.get("etag");
    assert.equal((await api("GET", "/collections", { token, headers: { "if-none-match": etag } })).status, 304);

    // A director's list, for "More from Christopher Nolan".
    const nolan = await api("GET", "/collections/director-christopher-nolan", { token });
    assert.equal(nolan.body.collection.title, "Christopher Nolan");
    assert.deepEqual(
      new Set(nolan.body.movies.map((movie) => movie.id)),
      new Set(nolan.body.collection.movieIds),
    );
    assert.equal((await api("GET", "/collections/director-nobody-at-all", { token })).status, 404);

    // A movie's page brings its sagas only, not the browsing lists.
    const inception = await api("GET", `/movies/${NOLAN.inception}`, { token });
    const own = inception.body.collections.map((collection) => collection.id);
    assert.ok(own.includes("saga-mind-bender"));
    assert.ok(!own.includes("director-christopher-nolan"));
    assert.ok(inception.body.collections.every((collection) => collection.type === "saga"));
  });

  test("a saga's page: its artwork, cards with votes, and friends' progress", async () => {
    const friend = await register("Nolan Friend", "nolanfriend");
    const me = (await api("GET", "/me/profile", { token })).body.profile;
    await api("POST", "/friends/requests", { token: friend.token, body: { userId: me.id } });
    await api("POST", `/friends/requests/${friend.user.id}/accept`, { token });
    await api("POST", "/me/watched", { token: friend.token, body: { movieId: NOLAN.memento, tier: "S" } });
    await api("POST", "/me/watched", { token: friend.token, body: { movieId: NOLAN.prestige } });
    await api("POST", "/me/watched", { token: friend.token, body: { movieId: "289" } }); // not Nolan's

    const page = await api("GET", "/collections/saga-mind-bender", { token });
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.art, SAGAS[1].art, "the artwork build-pool picked");
    assert.ok(page.body.movies.every((movie) => typeof movie.votes === "number"));
    assert.equal(page.body.friends.length, 1);
    const [entry] = page.body.friends;
    assert.equal(entry.user.id, friend.user.id);
    assert.equal(entry.watchedCount, 2);
    assert.deepEqual(entry.tiers, { [NOLAN.memento]: "S", [NOLAN.prestige]: null });

    // Someone with no friends there sees none.
    const loner = await register("Lone Viewer", "loneviewer");
    assert.deepEqual((await api("GET", "/collections/saga-mind-bender", { token: loner.token })).body.friends, []);

    // A friend's profile: their finished sagas (trophies), with the
    // definitions to show them.
    for (const movieId of ["155", "272", "49026"]) {
      await api("POST", "/me/watched", { token: friend.token, body: { movieId } });
    }
    const profile = await api("GET", `/users/${friend.user.id}`, { token });
    assert.deepEqual(profile.body.user.finishedCollections, ["saga-gothams-guardian"]);
    assert.ok(profile.body.collections.some((collection) => collection.id === "saga-gothams-guardian"));
    // A stranger gets just the public card.
    const strangerView = await api("GET", `/users/${friend.user.id}`, { token: loner.token });
    assert.equal(strangerView.body.user.finishedCollections, undefined);

    // A franchise list falls back to one of its films' backdrops.
    const franchise = await api("GET", "/collections/franchise-the-dark-knight-trilogy", { token });
    assert.ok(franchise.body.art?.backdrop?.startsWith("https://"));
  });

  test("saga ladders aren't ranks", async () => {
    const climber = await register("Rank Climber", "rankclimber");
    // Batman Begins and The Dark Knight climb Gotham's Guardian, Inception
    // Mind-Bender — none of it is a rank.
    for (const movieId of ["272", NOLAN.darkKnight, NOLAN.inception]) {
      await api("POST", "/me/watched", { token: climber.token, body: { movieId } });
    }
    const profile = (await api("GET", "/me/profile", { token: climber.token })).body.profile;
    assert.ok(profile.rankIds.includes("films:1"));
    assert.ok(profile.rankIds.every((id) => !id.startsWith("saga-")), profile.rankIds.join());
  });
});

describe("library", () => {
  let token;
  before(async () => {
    ({ token } = await register("Lib User", "libuser"));
  });

  test("watchlist → pick → watched clears both and completes the challenge", async () => {
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "539" } })).status, 201);
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "539" } })).status, 200);
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "999999999" } })).status, 404);

    await api("PUT", "/me/pick", { token, body: { movieId: "539", mood: "cozy" } });
    const pick = await api("GET", "/me/pick", { token });
    assert.deepEqual(pick.body, { pickedMovie: "539", pickMood: { movieId: "539", mood: "cozy" } });

    const accepted = await api("POST", "/me/challenges/active", {
      token,
      body: { challenge: { id: "c-1", type: "decade", title: "Go old", targetMovieId: "539", xpReward: 120 } },
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.activeChallenge.title, "Go old");

    const watched = await api("POST", "/me/watched", { token, body: { movieId: "539", tier: "A" } });
    assert.equal(watched.status, 201);
    assert.equal(watched.body.entry.tier, "A");
    assert.equal(watched.body.entry.watchCount, 1);
    assert.equal(watched.body.completedChallenge.status, "completed");
    assert.equal(watched.body.completedChallenge.xpReward, 120);

    const state = await api("GET", "/me", { token });
    assert.deepEqual(state.body.library.bucketList, []);
    assert.equal(state.body.library.pickedMovie, null);
    assert.equal(state.body.challenges.activeChallenge, null);
    assert.equal(state.body.challenges.history.length, 1);

    const library = await api("GET", "/me/library", { token });
    const { movies, collections, ...rest } = library.body;
    assert.deepEqual(rest, state.body.library);
    // The app has no catalog: the library brings its own movies.
    const sent = new Set(movies.map((movie) => movie.id));
    assert.ok(state.body.library.watched.every((entry) => sent.has(entry.movieId)));
    assert.deepEqual(collections, state.body.collections);

    // Nothing active any more: skipping is a harmless no-op.
    const skipped = await api("POST", "/me/challenges/active/skip", { token });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.history.length, 1);
  });

  test("tier, date, rewatch and unwatch", async () => {
    await api("POST", "/me/watched", { token, body: { movieId: "213" } });

    const future = Date.now() + 1e9;
    const patched = await api("PATCH", "/me/watched/213", { token, body: { tier: "S", watchedAt: future } });
    assert.equal(patched.body.entry.tier, "S");
    assert.ok(patched.body.entry.timestamp <= Date.now(), "never in the future");

    assert.equal((await api("PATCH", "/me/watched/213", { token, body: { tier: "Z" } })).status, 400);
    assert.equal((await api("PATCH", "/me/watched/239", { token, body: { tier: "S" } })).status, 404);

    const rewatch = await api("POST", "/me/watched/213/rewatch", { token });
    assert.equal(rewatch.body.entry.watchCount, 2);

    assert.equal((await api("DELETE", "/me/watched/213", { token })).status, 204);
    // Removing it again (a retry) still succeeds.
    assert.equal((await api("DELETE", "/me/watched/213", { token })).status, 204);
    assert.equal((await api("DELETE", "/me/watchlist/213", { token })).status, 204);
  });

  test("a change re-sent with the same Idempotency-Key is applied once", async () => {
    await api("POST", "/me/watched", { token, body: { movieId: "595" } });
    const headers = { "idempotency-key": "rewatch-595-0001" };
    const first = await api("POST", "/me/watched/595/rewatch", { token, headers });
    assert.equal(first.body.entry.watchCount, 2);
    const replay = await api("POST", "/me/watched/595/rewatch", { token, headers });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.body, first.body);
    const entry = (await api("GET", "/me/watched", { token })).body.watched.find((e) => e.movieId === "595");
    assert.equal(entry.watchCount, 2, "the replay didn't count a third watch");

    // A 204 is replayed too, and a key can't be reused for another request.
    const deleteHeaders = { "idempotency-key": "unwatch-595-0001" };
    assert.equal((await api("DELETE", "/me/watched/595", { token, headers: deleteHeaders })).status, 204);
    assert.equal((await api("DELETE", "/me/watched/595", { token, headers: deleteHeaders })).status, 204);
    assert.equal((await api("POST", "/me/watched/595/rewatch", { token, headers: deleteHeaders })).status, 409);
    assert.equal((await api("DELETE", "/me/watched/595", { token, headers: { "idempotency-key": "x" } })).status, 400);

    // Keys are per account.
    const other = await register("Other Idem", "otheridem");
    await api("POST", "/me/watched", { token: other.token, body: { movieId: "595" } });
    const theirs = await api("POST", "/me/watched/595/rewatch", { token: other.token, headers });
    assert.equal(theirs.body.entry.watchCount, 2);
    assert.equal(theirs.headers.get("idempotent-replayed"), null);
  });

  test("recommendations skip watched movies and honour the count", async () => {
    const recs = await api("GET", "/me/recommendations?count=12", { token });
    assert.equal(recs.body.movies.length, 12);
    assert.ok(!recs.body.movies.some((movie) => movie.id === "539"));
  });

  test("unlocked collections, top ten, pinned, profile, settings, searches", async () => {
    let r = await api("PUT", "/me/unlocked-collections/director-nolan", { token });
    assert.deepEqual(r.body.unlockedCollections, ["director-nolan"]);
    r = await api("DELETE", "/me/unlocked-collections/director-nolan", { token });
    assert.deepEqual(r.body.unlockedCollections, []);

    r = await api("PUT", "/me/top-ten", { token, body: { movieIds: ["872", "289"] } });
    assert.deepEqual(r.body.topTen, ["872", "289"]);
    assert.equal((await api("PUT", "/me/top-ten", { token, body: { movieIds: ["289", "289"] } })).status, 400);

    r = await api("PUT", "/me/pinned-collections", { token, body: { collectionIds: ["a", "b", "c", "d"] } });
    assert.equal(r.status, 400);

    r = await api("PATCH", "/me/profile", { token, body: { bio: "Film nerd", level: 4, ranks: 40, xp: 2400 } });
    assert.equal(r.body.profile.bio, "Film nerd");
    // Ranks and title come from the watch history, not from the app.
    assert.notEqual(r.body.profile.ranks, 40);
    assert.equal(r.body.profile.level, 1);

    r = await api("PATCH", "/me/settings", {
      token,
      body: { language: "ar", preferences: { genres: ["Drama"] }, tipsSeen: { home: true } },
    });
    assert.equal(r.body.settings.language, "ar");
    assert.deepEqual(r.body.settings.preferences.genres, ["Drama"]);
    assert.equal(r.body.settings.preferences.minRating, 7, "partial preferences are merged");
    assert.deepEqual(r.body.settings.tipsSeen, { home: true });

    for (const term of ["a", "b", "A", "c", "d", "e", "f", "g", "h", "i"]) {
      r = await api("POST", "/me/searches", { token, body: { term } });
    }
    assert.equal(r.body.recentSearches.length, 8);
    assert.equal(r.body.recentSearches[0], "i");
    // "A" replaced the earlier "a" (case-insensitive dedupe) rather than adding a second one.
    assert.deepEqual(r.body.recentSearches.filter((t) => t.toLowerCase() === "a"), ["A"]);
  });

  test("taste: leanings, aspects, passes", async () => {
    await api("PUT", "/me/taste/leanings", { token, body: { leanings: [1, 0, -1, 0, 1, 0] } });
    await api("PUT", "/me/taste/aspects/539", { token, body: { aspects: ["the twist", "the twist"] } });
    await api("POST", "/me/taste/passes", { token, body: { movieId: "284" } });
    const taste = await api("GET", "/me/taste", { token });
    assert.deepEqual(taste.body.leanings, [1, 0, -1, 0, 1, 0]);
    assert.deepEqual(taste.body.aspects, { 539: ["the twist"] });
    assert.equal(taste.body.passes[0].movieId, "284");
    assert.equal((await api("PUT", "/me/taste/leanings", { token, body: { leanings: [2] } })).status, 400);
  });
});

describe("ranks and title", () => {
  test("the title ladder", () => {
    assert.deepEqual(
      [0, 2, 3, 7, 8, 13, 14, 19, 20, 26, 27, 33, 34, 39].map(titleStepFor),
      [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
    );
    assert.equal(titleName(3), "Front Row");
    assert.equal(titleName(99), "Archivist");
  });

  test("worked out by the server from the watch history; app-sent values are ignored", async () => {
    const { token } = await register("Rank User", "rankuser");
    const profile = async () => (await api("GET", "/me/profile", { token })).body.profile;
    let p = await profile();
    assert.equal(p.ranks, 0);
    assert.equal(p.title, "Walk-in");

    // The first film is a rank: First Watch. (Watched at one fixed noon,
    // so the three below fall on the same day whenever this runs.)
    const noon = Date.UTC(2026, 0, 1, 12);
    await api("POST", "/me/watched", { token, body: { movieId: "238", watchedAt: noon } });
    p = await profile();
    assert.deepEqual(p.rankIds, ["films:1"]);
    assert.equal(p.ranks, 1);

    // Three D or F tiers: Tough Critic. (Three films in a day: Marathoner.)
    for (const movieId of ["238", "240", "28"]) {
      if (movieId !== "238") await api("POST", "/me/watched", { token, body: { movieId, watchedAt: noon } });
      await api("PATCH", `/me/watched/${movieId}`, { token, body: { tier: "F" } });
    }
    p = await profile();
    assert.ok(p.rankIds.includes("tough-critic:1"), p.rankIds.join());
    assert.ok(p.rankIds.includes("marathoner:1"), p.rankIds.join());
    // A better tier takes the harsh one back.
    await api("PATCH", "/me/watched/28", { token, body: { tier: "A" } });
    assert.ok(!(await profile()).rankIds.includes("tough-critic:1"));

    // Three rewatched films: Comfort Watcher.
    for (const movieId of ["238", "240", "28"]) {
      await api("POST", `/me/watched/${movieId}/rewatch`, { token });
    }
    assert.ok((await profile()).rankIds.includes("comfort-watcher:1"));

    // A finished dare: Dare Devil.
    await api("POST", "/me/challenges/active", {
      token,
      body: { challenge: { id: "dare-1", type: "decade", title: "Go old", targetMovieId: "539" } },
    });
    await api("POST", "/me/watched", { token, body: { movieId: "539" } });
    p = await profile();
    assert.ok(p.rankIds.includes("dare-devil:1"));
    assert.equal(p.ranks, p.rankIds.length);

    // A modified app claiming more changes nothing.
    const faked = await api("PATCH", "/me/profile", { token, body: { ranks: 999, level: 7, bio: "hi" } });
    assert.equal(faked.status, 200);
    assert.equal(faked.body.profile.ranks, p.ranks);
    assert.equal(faked.body.profile.level, titleStepFor(p.ranks));
    assert.equal(faked.body.profile.bio, "hi");

    // Clearing the history leaves the dare.
    await api("DELETE", "/me/watched", { token });
    assert.deepEqual((await profile()).rankIds, ["dare-devil:1"]);
  });

  test("friends see the server's ranks and title; rarity counts everyone's", async () => {
    const a = await register("Rank A", "ranka");
    const b = await register("Rank B", "rankb");
    for (const movieId of ["289", "15", "872", "389", "539", "426", "213", "239"]) {
      await api("POST", "/me/watched", { token: a.token, body: { movieId, tier: "A" } });
    }
    await api("PATCH", "/me/profile", { token: a.token, body: { level: 1 } });
    await api("POST", "/friends/requests", { token: b.token, body: { userId: a.user.id } });
    await api("POST", `/friends/requests/${b.user.id}/accept`, { token: a.token });
    const friend = (await api("GET", "/friends", { token: b.token })).body.friends[0];
    const own = (await api("GET", "/me/profile", { token: a.token })).body.profile;
    assert.ok(own.ranks >= 2);
    assert.equal(friend.ranks, own.ranks);
    assert.equal(friend.level, own.level);
    assert.equal(friend.title, own.title);

    const rarity = await api("GET", "/ranks/rarity", { token: b.token });
    assert.equal(rarity.status, 200);
    assert.ok(rarity.body.watchers >= 1);
    assert.ok(rarity.body.rarity["films:1"] >= 1 && rarity.body.rarity["films:1"] <= 100);
    assert.equal(rarity.body.rarity["films:7"], undefined, "nobody has watched 1000 films");
  });
});

describe("movie night across phones", () => {
  test("host, join by code, hidden picks, reveal of what everyone kept", async () => {
    const host = await register("Night Host", "nighthost");
    const guest = await register("Night Guest", "nightguest");
    const third = await register("Night Third", "nightthird");
    const stranger = await register("Night Stranger", "nightstranger");
    const stack = ["289", "15", "872", "389", "539"];

    assert.equal((await api("POST", "/movie-nights", { token: host.token, body: { movieIds: ["289", "15"] } })).status, 400);
    const created = await api("POST", "/movie-nights", { token: host.token, body: { movieIds: stack } });
    assert.equal(created.status, 201);
    const night = created.body.night;
    assert.match(night.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(night.isHost, true);
    assert.equal(night.results, null);

    assert.equal((await api("POST", "/movie-nights/join", { token: guest.token, body: { code: "ZZZZZZ" } })).status, 404);
    const joined = await api("POST", "/movie-nights/join", { token: guest.token, body: { code: night.code.toLowerCase() } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.night.members.length, 2);
    await api("POST", "/movie-nights/join", { token: third.token, body: { code: night.code } });

    // Strangers can't look in.
    assert.equal((await api("GET", `/movie-nights/${night.id}`, { token: stranger.token })).status, 404);

    // Picks must come from the stack; then they stay hidden until all are done.
    assert.equal((await api("PUT", `/movie-nights/${night.id}/picks`, { token: host.token, body: { kept: ["424"] } })).status, 400);
    await api("PUT", `/movie-nights/${night.id}/picks`, { token: host.token, body: { kept: ["289", "15", "872"] } });
    let view = (await api("PUT", `/movie-nights/${night.id}/picks`, { token: guest.token, body: { kept: ["15", "872", "539"] } })).body.night;
    assert.equal(view.results, null, "not revealed while someone is still swiping");
    assert.deepEqual(view.me.kept, ["15", "872", "539"]);
    assert.deepEqual(view.members.map((m) => m.done), [true, true, false]);

    view = (await api("PUT", `/movie-nights/${night.id}/picks`, { token: third.token, body: { kept: ["872", "15"] } })).body.night;
    assert.equal(view.results.everyoneDone, true);
    assert.deepEqual(view.results.matches, ["15", "872"]);
    assert.equal(view.results.counts["289"], 1);
    assert.equal(view.results.voters, 3);

    // Once it's over nobody new can join; the host ending it twice is fine.
    assert.equal((await api("POST", `/movie-nights/${night.id}/close`, { token: guest.token })).status, 403);
    await api("POST", `/movie-nights/${night.id}/close`, { token: host.token });
    assert.equal((await api("POST", "/movie-nights/join", { token: stranger.token, body: { code: night.code } })).status, 409);
  });

  test("the host can end it early; the host leaving ends it for everyone", async () => {
    const host = await register("Early Host", "earlyhost");
    const guest = await register("Early Guest", "earlyguest");
    const night = (await api("POST", "/movie-nights", { token: host.token, body: { movieIds: ["289", "15", "872", "389"] } })).body.night;
    await api("POST", "/movie-nights/join", { token: guest.token, body: { code: night.code } });
    await api("PUT", `/movie-nights/${night.id}/picks`, { token: host.token, body: { kept: ["289"] } });

    const closed = (await api("POST", `/movie-nights/${night.id}/close`, { token: host.token })).body.night;
    assert.equal(closed.status, "closed");
    assert.equal(closed.results.everyoneDone, false);
    assert.deepEqual(closed.results.matches, [], "one finisher can't make a match");

    assert.equal((await api("DELETE", `/movie-nights/${night.id}/members/me`, { token: host.token })).status, 204);
    assert.equal((await api("GET", `/movie-nights/${night.id}`, { token: guest.token })).status, 404);
  });

  test("no more than 8 people", async () => {
    const host = await register("Full Host", "fullhost");
    const night = (await api("POST", "/movie-nights", { token: host.token, body: { movieIds: ["289", "15", "872", "389"] } })).body.night;
    for (let i = 0; i < 7; i += 1) {
      const guest = await register(`Full Guest ${i}`, `fullguest${i}`);
      assert.equal((await api("POST", "/movie-nights/join", { token: guest.token, body: { code: night.code } })).status, 200);
    }
    const late = await register("Too Late", "toolate");
    assert.equal((await api("POST", "/movie-nights/join", { token: late.token, body: { code: night.code } })).status, 409);
  });
});

describe("push notifications", () => {
  // Record what would go to Expo instead of sending it.
  const sent = [];
  const realSend = pushTransport.send;
  let tickets = () => [];
  before(() => {
    pushTransport.send = async (messages) => {
      sent.push(...messages);
      return tickets(messages);
    };
  });
  after(() => {
    pushTransport.send = realSend;
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("friend requests and acceptances notify the other person, in their language", async () => {
    const asker = await register("Push Asker", "pushasker");
    const friend = await register("Push Friend", "pushfriend");
    await api("PATCH", "/me/settings", { token: friend.token, body: { language: "ar" } });
    assert.equal((await api("POST", "/me/push-tokens", { token: friend.token, body: { token: "ExponentPushToken[friend-1]", platform: "android" } })).status, 204);
    assert.equal((await api("POST", "/me/push-tokens", { token: asker.token, body: { token: "ExponentPushToken[asker-1]" } })).status, 204);

    sent.length = 0;
    await api("POST", "/friends/requests", { token: asker.token, body: { userId: friend.user.id } });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "ExponentPushToken[friend-1]");
    assert.match(sent[0].title, /Push Asker/);
    assert.match(sent[0].title, /صديق/, "in the friend's language (Arabic)");
    assert.equal(sent[0].data.url, "reelboard://friends");

    sent.length = 0;
    await api("POST", `/friends/requests/${asker.user.id}/accept`, { token: friend.token });
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "ExponentPushToken[asker-1]");
    assert.equal(sent[0].title, "Push Friend accepted your friend request");
  });

  test("movie night: the host hears who joins; everyone hears when results are in", async () => {
    const host = await register("Push Host", "pushhost");
    const guest = await register("Push Guest", "pushguest");
    await api("POST", "/me/push-tokens", { token: host.token, body: { token: "ExponentPushToken[host-1]" } });
    await api("POST", "/me/push-tokens", { token: guest.token, body: { token: "ExponentPushToken[guest-1]" } });
    const night = (await api("POST", "/movie-nights", { token: host.token, body: { movieIds: ["289", "15", "872", "389"] } })).body.night;

    sent.length = 0;
    await api("POST", "/movie-nights/join", { token: guest.token, body: { code: night.code } });
    await settle();
    assert.deepEqual(sent.map((m) => [m.to, m.title]), [["ExponentPushToken[host-1]", "Push Guest joined your movie night"]]);
    assert.equal(sent[0].data.url, `reelboard://night/${night.code}`);

    sent.length = 0;
    await api("PUT", `/movie-nights/${night.id}/picks`, { token: host.token, body: { kept: ["289"] } });
    await settle();
    assert.equal(sent.length, 0, "nothing until the last person finishes");
    await api("PUT", `/movie-nights/${night.id}/picks`, { token: guest.token, body: { kept: ["289"] } });
    await settle();
    assert.deepEqual(sent.map((m) => m.to), ["ExponentPushToken[host-1]"], "everyone but the last finisher");
    assert.equal(sent[0].title, "Everyone's done swiping");
  });

  test("a token Expo says is gone is forgotten; tokens can be removed", async () => {
    const user = await register("Push Gone", "pushgone");
    const other = await register("Push Other", "pushother");
    await api("POST", "/me/push-tokens", { token: user.token, body: { token: "ExponentPushToken[gone-1]" } });
    tickets = (messages) => messages.map(() => ({ status: "error", details: { error: "DeviceNotRegistered" } }));
    await api("POST", "/friends/requests", { token: other.token, body: { userId: user.user.id } });
    await settle();
    tickets = () => [];
    assert.equal(get("SELECT 1 AS present FROM push_tokens WHERE token = ?", ["ExponentPushToken[gone-1]"]), null);

    await api("POST", "/me/push-tokens", { token: user.token, body: { token: "ExponentPushToken[keep-1]" } });
    assert.equal((await api("DELETE", "/me/push-tokens", { token: user.token, body: { token: "ExponentPushToken[keep-1]" } })).status, 204);
    assert.equal(get("SELECT 1 AS present FROM push_tokens WHERE token = ?", ["ExponentPushToken[keep-1]"]), null);
  });
});

describe("activity cleanup", () => {
  test("drops events past 90 days and beyond each person's newest 200", async () => {
    const { user } = await register("Busy Watcher", "busywatcher");
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const insert = (id, createdAt) =>
      run("INSERT INTO activity (id, user_id, type, data, created_at) VALUES (?, ?, 'badge', '{}', ?)", [
        id,
        user.id,
        createdAt,
      ]);
    insert("a_ancient", now - 120 * day);
    for (let i = 0; i < 205; i += 1) insert(`a_recent_${i}`, now - i * 1000);

    const removed = pruneActivity({ now });
    assert.equal(removed, 1 + 5);
    const left = all("SELECT id FROM activity WHERE user_id = ? ORDER BY created_at DESC", [user.id]);
    assert.equal(left.length, 200);
    assert.equal(left[0].id, "a_recent_0");
    assert.ok(!left.some((row) => row.id === "a_ancient" || row.id === "a_recent_204"));
  });
});

describe("boards", () => {
  test("create, add, reorder, rename, remove, delete", async () => {
    const { token } = await register("Board User", "boarduser");
    const created = await api("POST", "/boards", { token, body: { name: "  Rainy day  ", movieIds: ["289"] } });
    assert.equal(created.status, 201);
    const { id } = created.body.board;
    assert.equal(created.body.board.name, "Rainy day");

    let r = await api("POST", `/boards/${id}/movies`, { token, body: { movieId: "15" } });
    r = await api("POST", `/boards/${id}/movies`, { token, body: { movieId: "15" } });
    assert.deepEqual(r.body.board.movieIds, ["289", "15"]);

    r = await api("PUT", `/boards/${id}/movies`, { token, body: { movieIds: ["15", "289", "872"] } });
    assert.deepEqual(r.body.board.movieIds, ["15", "289", "872"]);

    r = await api("PATCH", `/boards/${id}`, { token, body: { name: "x".repeat(41) } });
    assert.equal(r.status, 400);
    r = await api("PATCH", `/boards/${id}`, { token, body: { name: "Date night" } });
    assert.equal(r.body.board.name, "Date night");

    r = await api("DELETE", `/boards/${id}/movies/289`, { token });
    assert.deepEqual(r.body.board.movieIds, ["15", "872"]);
    r = await api("DELETE", `/boards/${id}/movies/289`, { token });
    assert.equal(r.status, 200, "already off the board");

    // The app's own board id is kept; creating it twice (a retry) is harmless.
    r = await api("POST", "/boards", { token, body: { id: "bm1x2y3z", name: "Mine" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.board.id, "bm1x2y3z");
    r = await api("POST", "/boards", { token, body: { id: "bm1x2y3z", name: "Mine" } });
    assert.equal(r.status, 200);
    const other = await register("Other Boarder", "otherboarder");
    r = await api("POST", "/boards", { token: other.token, body: { id: "bm1x2y3z", name: "Theirs" } });
    assert.equal(r.status, 409);
    await api("DELETE", "/boards/bm1x2y3z", { token });

    assert.equal((await api("GET", "/boards", { token })).body.boards.length, 1);
    assert.equal((await api("DELETE", `/boards/${id}`, { token })).status, 204);
    assert.equal((await api("GET", `/boards/${id}`, { token })).status, 404);
    assert.equal((await api("DELETE", `/boards/${id}`, { token })).status, 204, "already gone");
  });
});

describe("friends and activity", () => {
  test("request, accept, see their library and feed; strangers see nothing", async () => {
    const sam = await register("Sam Rivera", "samr");
    const omar = await register("Omar Saleh", "omar");
    const stranger = await register("Stranger", "stranger");

    const board = await api("POST", "/boards", { token: sam.token, body: { name: "Sci-fi" } });
    await api("POST", "/me/watched", { token: sam.token, body: { movieId: "155", tier: "S" } });
    await api("POST", "/activity", {
      token: sam.token,
      body: { type: "badge", badge: "Cinephile" },
    });

    const found = await api("GET", "/users/search?q=@sam", { token: omar.token });
    const samResult = found.body.users.find((user) => user.handle === "@samr");
    assert.equal(samResult.relationship, "none");

    let r = await api("POST", "/friends/requests", { token: omar.token, body: { handle: "@samr" } });
    assert.equal(r.status, 201);
    assert.equal((await api("POST", "/friends/requests", { token: omar.token, body: { handle: "samr" } })).status, 409);

    // Not friends yet: no library, no boards.
    r = await api("GET", `/users/${sam.user.id}`, { token: omar.token });
    assert.equal(r.body.user.relationship, "outgoing");
    assert.equal(r.body.user.watched, undefined);
    assert.equal((await api("GET", `/boards/${board.body.board.id}`, { token: omar.token })).status, 404);

    const requests = await api("GET", "/friends/requests", { token: sam.token });
    assert.equal(requests.body.incoming[0].user.handle, "@omar");
    r = await api("POST", `/friends/requests/${omar.user.id}/accept`, { token: sam.token });
    assert.equal(r.body.relationship, "friends");

    const friends = await api("GET", "/friends", { token: omar.token });
    assert.equal(friends.body.friends.length, 1);
    assert.deepEqual(
      friends.body.friends[0].watched.map(({ movieId, tier }) => ({ movieId, tier })),
      [{ movieId: "155", tier: "S" }],
    );

    // Friends can view (but not edit) boards.
    assert.equal((await api("GET", `/boards/${board.body.board.id}`, { token: omar.token })).status, 200);
    assert.equal(
      (await api("PATCH", `/boards/${board.body.board.id}`, { token: omar.token, body: { name: "Mine" } })).status,
      403,
    );

    const feed = await api("GET", "/activity", { token: omar.token });
    const types = feed.body.activity.map((event) => event.type).sort();
    assert.deepEqual(types, ["badge", "tier", "watched"]);
    const tierEvent = feed.body.activity.find((event) => event.type === "tier");
    assert.equal(tierEvent.title, "The Dark Knight");
    assert.equal(tierEvent.friend.id, sam.user.id);
    assert.equal(tierEvent.friendId, sam.user.id);

    // Re-tiering within the hour updates the event rather than adding one.
    await api("PATCH", "/me/watched/155", { token: sam.token, body: { tier: "A" } });
    const feed2 = await api("GET", "/activity", { token: omar.token });
    const tiers = feed2.body.activity.filter((event) => event.type === "tier");
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0].tier, "A");

    assert.deepEqual((await api("GET", "/activity", { token: stranger.token })).body.activity, []);

    assert.equal((await api("DELETE", `/friends/${sam.user.id}`, { token: omar.token })).status, 204);
    assert.equal((await api("GET", "/friends", { token: omar.token })).body.friends.length, 0);
  });

  test("a request back to someone who already asked accepts it", async () => {
    const a = await register("Maya Chen", "mayac");
    const b = await register("Noor Aziz", "noor");
    await api("POST", "/friends/requests", { token: a.token, body: { userId: b.user.id } });
    const r = await api("POST", "/friends/requests", { token: b.token, body: { userId: a.user.id } });
    assert.equal(r.body.relationship, "friends");
  });
});

describe("import and account deletion", () => {
  test("imports the app's local stores, skipping unknown movies", async () => {
    const { token } = await register("Importer", "importer");
    const r = await api("POST", "/me/import", {
      token,
      body: {
        movieStore: {
          bucketList: [{ movieId: "947", addedAt: 1700000000000 }, { movieId: "999999999", addedAt: 1 }],
          watched: [
            { movieId: "289", timestamp: 1700000000000, tier: "S", watchCount: 3 },
            { movieId: "15", timestamp: 1700000001000, rating: 4.5 },
            "garbage",
          ],
          pickedMovie: "947",
          pickMood: { movieId: "947", mood: "epic" },
          unlockedCollections: ["decade-1990s"],
        },
        boardStore: { boards: [{ id: "bxyz", name: "Old board", movieIds: ["289", "15", "999999999"], createdAt: 1 }] },
        profileStore: { displayName: "You", bio: "hi", topTen: ["289"], pinnedCollections: [] },
        userStore: { preferences: { decade: "1990s" }, hasCompletedOnboarding: true },
        tasteStore: { aspects: { 289: ["the twist"] }, passes: [{ movieId: "872", at: 5 }], leanings: null },
        challengeStore: {
          activeChallenge: { id: "c-2", targetMovieId: "947", title: "Watch it" },
          history: [{ id: "c-1", targetMovieId: "289", status: "completed", resolvedAt: 10 }],
        },
        languageStore: { language: "ar" },
        themeStore: { mode: "dark" },
        tipsStore: { seen: { swipe: true } },
        recentSearchStore: { recentSearches: ["kubrick"] },
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const state = r.body;
    assert.deepEqual(state.library.bucketList.map((e) => e.movieId), ["947"]);
    assert.equal(state.library.watched.length, 2);
    assert.equal(state.library.watched.find((e) => e.movieId === "289").watchCount, 3);
    assert.equal(state.library.watched.find((e) => e.movieId === "15").rating, 4.5);
    assert.deepEqual(state.library.pickMood, { movieId: "947", mood: "epic" });
    assert.deepEqual(state.boards[0].movieIds, ["289", "15"]);
    assert.equal(state.profile.displayName, "Importer", "placeholder 'You' doesn't overwrite");
    assert.equal(state.settings.preferences.decade, "1990s");
    assert.equal(state.settings.hasCompletedOnboarding, true);
    assert.equal(state.settings.theme, "dark");
    assert.equal(state.challenges.activeChallenge.title, "Watch it");
    assert.equal(state.challenges.history[0].status, "completed");
    assert.deepEqual(state.recentSearches, ["kubrick"]);
  });

  test("deleting an account needs the password and invalidates the token", async () => {
    const { token } = await register("Leaver", "leaver");
    assert.equal((await api("DELETE", "/me", { token, body: { password: "nope" } })).status, 401);
    assert.equal((await api("DELETE", "/me", { token, body: { password: "password123" } })).status, 204);
    assert.equal((await api("GET", "/me", { token })).status, 401);
  });
});

describe("community", () => {
  test("tier totals per movie, trending and favourites — totals only", async () => {
    const a = await register("Comm A", "comma");
    const b = await register("Comm B", "commb");
    const c = await register("Comm C", "commc");
    const watch = (who, movieId, tier) =>
      api("POST", "/me/watched", { token: who.token, body: { movieId, tier } });
    await watch(a, "703", "S");
    await watch(b, "703", "S");
    await watch(c, "703", "B");
    await watch(a, "1366", "S"); // only one tier: not a "favourite" yet
    await watch(a, "9552", null);
    await watch(b, "9552", null);
    await api("POST", "/me/watchlist", { token: c.token, body: { movieId: "9552" } });

    const counts = await api("GET", "/community/movies/703", { token: a.token });
    assert.equal(counts.status, 200);
    assert.deepEqual(counts.body.tiers, { S: 2, A: 0, B: 1, C: 0, D: 0, F: 0 });
    assert.equal(counts.body.tieredCount, 3);
    assert.equal(counts.body.watchedCount, 3);
    assert.ok(!JSON.stringify(counts.body).includes(a.user.id), "nobody's identity is in it");
    assert.equal((await api("GET", "/community/movies/9552", { token: a.token })).body.watchlistCount, 1);
    assert.equal((await api("GET", "/community/movies/703")).status, 401, "signed in only");

    const { body } = await api("GET", "/community/trending?days=7&limit=50", { token: a.token });
    assert.equal(body.trending.find((row) => row.movieId === "9552").count, 3, "2 watched + 1 saved");
    const fav = body.favorites.find((row) => row.movieId === "703");
    assert.equal(fav.tieredCount, 3);
    assert.equal(fav.lovedShare, 0.67);
    assert.ok(!body.favorites.some((row) => row.movieId === "1366"), "needs 2+ tiers");
  });
});

describe("clubs", () => {
  test("create, join by code, shared board, now watching, tier list, feed", async () => {
    const owner = await register("Club Owner", "clubowner");
    const member = await register("Club Member", "clubmember");
    const stranger = await register("Club Stranger", "clubstranger");

    let r = await api("POST", "/clubs", {
      token: owner.token,
      body: { name: "  Horror Nights ", description: "Scary stuff", movieIds: ["85"] },
    });
    assert.equal(r.status, 201);
    const club = r.body.club;
    assert.equal(club.name, "Horror Nights");
    assert.equal(club.role, "owner");
    assert.match(club.inviteCode, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.deepEqual(club.movies.map((m) => m.movieId), ["85"]);

    // Strangers can't see it; the code lets you in (case doesn't matter).
    assert.equal((await api("GET", `/clubs/${club.id}`, { token: stranger.token })).status, 404);
    assert.equal((await api("POST", "/clubs/join", { token: member.token, body: { code: "NOPE1234" } })).status, 404);
    r = await api("POST", "/clubs/join", { token: member.token, body: { code: club.inviteCode.toLowerCase() } });
    assert.equal(r.status, 201);
    assert.equal(r.body.club.role, "member");
    assert.equal(r.body.club.memberCount, 2);
    r = await api("POST", "/clubs/join", { token: member.token, body: { code: club.inviteCode } });
    assert.equal(r.status, 200, "joining again is harmless");

    // Members add to the board; tiers on club movies show per member.
    r = await api("POST", `/clubs/${club.id}/movies`, { token: member.token, body: { movieId: "1891" } });
    assert.deepEqual(r.body.club.movies.map((m) => m.movieId), ["85", "1891"]);
    await api("POST", "/me/watched", { token: member.token, body: { movieId: "85", tier: "A" } });
    await api("POST", "/me/watched", { token: member.token, body: { movieId: "424", tier: "F" } }); // not a club movie
    await api("POST", "/me/watched", { token: owner.token, body: { movieId: "85", tier: "S" } });
    r = await api("GET", `/clubs/${club.id}`, { token: member.token });
    const boardEntry = r.body.club.movies.find((m) => m.movieId === "85");
    assert.deepEqual(
      boardEntry.watches.map((w) => w.tier).sort(),
      ["A", "S"],
    );
    assert.equal(r.body.club.members[0].role, "owner", "owner listed first");

    // Only the owner sets now watching / renames; a member can't remove the owner's movie.
    assert.equal((await api("PATCH", `/clubs/${club.id}`, { token: member.token, body: { nowWatching: "1892" } })).status, 403);
    r = await api("PATCH", `/clubs/${club.id}`, { token: owner.token, body: { nowWatching: "1892", name: "Horror Club" } });
    assert.equal(r.body.club.nowWatching.movieId, "1892");
    assert.equal(r.body.club.name, "Horror Club");
    assert.equal((await api("DELETE", `/clubs/${club.id}/movies/85`, { token: member.token })).status, 403);
    r = await api("DELETE", `/clubs/${club.id}/movies/1891`, { token: member.token });
    assert.deepEqual(r.body.club.movies.map((m) => m.movieId), ["85"], "their own one they can");

    // The feed covers club movies (and now watching) only.
    await api("POST", "/me/watched", { token: member.token, body: { movieId: "1892" } });
    r = await api("GET", `/clubs/${club.id}/activity`, { token: owner.token });
    const movies = new Set(r.body.activity.map((event) => event.movieId));
    assert.ok(movies.has("85") && movies.has("1892"));
    assert.ok(!movies.has("424"), "nothing outside the club's movies");

    // Your clubs list.
    r = await api("GET", "/clubs", { token: member.token });
    assert.deepEqual(r.body.clubs.map((c) => c.name), ["Horror Club"]);
    assert.equal(r.body.clubs[0].nowWatching, "1892");
    assert.deepEqual(r.body.clubs[0].movieIds, ["85"]);

    // New invite code: the old one stops working.
    r = await api("POST", `/clubs/${club.id}/invite`, { token: owner.token });
    assert.notEqual(r.body.inviteCode, club.inviteCode);
    assert.equal((await api("POST", "/clubs/join", { token: stranger.token, body: { code: club.inviteCode } })).status, 404);

    // Owner can't leave; members can (twice is fine); owner can remove members.
    assert.equal((await api("POST", `/clubs/${club.id}/leave`, { token: owner.token })).status, 400);
    r = await api("POST", "/clubs/join", { token: stranger.token, body: { code: r.body.inviteCode } });
    r = await api("DELETE", `/clubs/${club.id}/members/${stranger.user.id}`, { token: owner.token });
    assert.equal(r.body.club.memberCount, 2);
    assert.equal((await api("POST", `/clubs/${club.id}/leave`, { token: member.token })).status, 204);
    assert.equal((await api("POST", `/clubs/${club.id}/leave`, { token: member.token })).status, 204);
    assert.equal((await api("GET", `/clubs/${club.id}`, { token: member.token })).status, 404);

    // Delete: owner only, then gone for everyone; again is fine.
    assert.equal((await api("DELETE", `/clubs/${club.id}`, { token: owner.token })).status, 204);
    assert.equal((await api("DELETE", `/clubs/${club.id}`, { token: owner.token })).status, 204);
    assert.deepEqual((await api("GET", "/clubs", { token: owner.token })).body.clubs, []);
  });

  test("rejects bad input", async () => {
    const { token } = await register("Club Bad", "clubbad");
    assert.equal((await api("POST", "/clubs", { token, body: { name: "" } })).status, 400);
    assert.equal((await api("POST", "/clubs", { token, body: { name: "x".repeat(41) } })).status, 400);
    assert.equal((await api("POST", "/clubs", { token, body: { name: "Ok", movieIds: ["999999999"] } })).status, 404);
  });
});

describe("TMDB: any movie, search, browse, people", () => {
  let token;
  before(async () => {
    ({ token } = await register("Tmdb User", "tmdbuser"));
  });

  test("search and lists — signed in only, adult titles left out", async () => {
    assert.equal((await api("GET", "/movies/search?q=fake")).status, 401);
    const found = await api("GET", "/movies/search?q=fake", { token });
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.results.map((movie) => movie.id), [FAKE_MOVIE_ID]);
    const [hit] = found.body.results;
    assert.equal(hit.title, "The Fake Film");
    assert.equal(hit.year, 2021);
    assert.equal(hit.rating, 7.8);
    assert.deepEqual(hit.genres, ["Sci-Fi", "Thriller"]);
    assert.match(hit.poster, /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/fake-poster\.jpg$/);
    assert.deepEqual((await api("GET", "/movies/search?q=nothing", { token })).body.results, []);
    assert.equal((await api("GET", "/movies/search?q=", { token })).status, 400);

    for (const kind of ["trending", "popular", "now-playing", "upcoming", "top-rated"]) {
      const list = await api("GET", `/movies/lists/${kind}?region=gb`, { token });
      assert.equal(list.body.results[0].id, FAKE_MOVIE_ID, kind);
    }
    assert.equal((await api("GET", "/movies/lists/nope", { token })).status, 400);
    const discover = await api("GET", "/movies/discover?genre=Sci-Fi&decade=2020s&sort=rating", { token });
    assert.equal(discover.body.results.length, 1);
    assert.equal((await api("GET", "/movies/discover?genre=Opera", { token })).status, 400);
  });

  test("a movie outside the pool is fetched once, then served by the server", async () => {
    const asked = () => tmdb.requests.filter((path) => path === `/movie/${FAKE_MOVIE_ID}`).length;
    const before = asked();
    const { movie } = (await api("GET", `/movies/${FAKE_MOVIE_ID}`, { token })).body;
    assert.equal(movie.title, "The Fake Film");
    assert.equal(movie.year, 2021);
    assert.equal(movie.rating, 7.8);
    assert.equal(movie.runtime, 118);
    assert.deepEqual(movie.genres, ["Sci-Fi", "Thriller"]);
    assert.equal(movie.director, "Dee Director");
    assert.deepEqual(movie.cast, ["Ada Actor", "Ben Bit"]);
    assert.equal(movie.franchise, "The Fake");
    assert.equal(movie.details.trailer, "trailer123", "the trailer beats the teaser");
    assert.equal(movie.details.rated, "PG-13");
    assert.equal(movie.details.castDetails[0].character, "Hero");
    assert.match(movie.details.castDetails[0].photo, /w185\/ada\.jpg$/);
    assert.equal(movie.details.castDetails[1].photo, null);
    assert.equal(movie.vibe.dims.length, 6);
    assert.ok(movie.vibe.dims.every((score) => score >= 1 && score <= 5));
    assert.ok(movie.vibe.themes.includes("war"), "TMDB's War genre becomes a theme");
    assert.equal(movie.vibeSource, "estimated");
    assert.equal(movie.inPool, false);

    await api("GET", `/movies/${FAKE_MOVIE_ID}`, { token });
    assert.equal(asked() - before, 1, "asked TMDB once");
  });

  test("save, watch and tier any movie; it comes back with the account and counts for ranks", async () => {
    const ranksBefore = (await api("GET", "/me/profile", { token })).body.profile.ranks;
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: FAKE_MOVIE_ID } })).status, 201);
    let me = (await api("GET", "/me", { token })).body;
    assert.deepEqual(me.movies.map((movie) => movie.id), [FAKE_MOVIE_ID]);
    assert.equal(me.movies[0].details.castDetails, undefined, "lists carry the lean shape");
    assert.equal(me.movies[0].details.trailer, "trailer123");

    await api("POST", "/me/watched", { token, body: { movieId: FAKE_MOVIE_ID, tier: "A" } });
    me = (await api("GET", "/me", { token })).body;
    assert.ok(me.profile.ranks > ranksBefore, "watching it counts (First Watch)");
    assert.deepEqual((await api("GET", "/me/library", { token })).body.movies.map((m) => m.id), [FAKE_MOVIE_ID]);

    // Friends get it with their friend list; the community counts it.
    const friend = await register("Tmdb Friend", "tmdbfriend");
    await api("POST", "/friends/requests", { token: friend.token, body: { handle: "tmdbuser" } });
    await api("POST", `/friends/requests/${friend.user.id}/accept`, { token });
    const friends = (await api("GET", "/friends", { token: friend.token })).body;
    assert.ok(friends.movies.some((movie) => movie.id === FAKE_MOVIE_ID));
    const community = (await api("GET", `/community/movies/${FAKE_MOVIE_ID}`, { token })).body;
    assert.equal(community.tiers.A, 1);

    // Boards and clubs take it too.
    const board = await api("POST", "/boards", { token, body: { name: "Found it", movieIds: [FAKE_MOVIE_ID] } });
    assert.equal(board.status, 201);
    const boards = (await api("GET", "/boards", { token })).body;
    assert.ok(boards.movies.some((movie) => movie.id === FAKE_MOVIE_ID));
    const club = await api("POST", "/clubs", { token, body: { name: "Fakers", movieIds: [FAKE_MOVIE_ID] } });
    assert.ok(club.body.movies.some((movie) => movie.id === FAKE_MOVIE_ID));
  });

  test("similar movies, where to watch, collections", async () => {
    const similar = await api("GET", `/movies/${FAKE_MOVIE_ID}/similar`, { token });
    assert.equal(similar.body.results.length, 1, "falls back to similar when there are no recommendations");

    const watch = (await api("GET", `/movies/${FAKE_MOVIE_ID}/providers`, { token })).body;
    assert.equal(watch.region, "US");
    assert.deepEqual(watch.stream.map((provider) => provider.name), ["First", "Second"]);
    assert.deepEqual(watch.rent.map((provider) => provider.name), ["Rent It"]);
    assert.deepEqual(watch.buy, []);
    assert.equal(watch.source, "JustWatch");
    const elsewhere = (await api("GET", `/movies/${FAKE_MOVIE_ID}/providers?region=gb`, { token })).body;
    assert.equal(elsewhere.region, "GB");
    assert.deepEqual(elsewhere.stream, []);
    assert.equal((await api("GET", `/movies/${FAKE_MOVIE_ID}/providers?region=usa`, { token })).status, 400);

    const { collection } = (await api("GET", `/movies/collections/${FAKE_COLLECTION_ID}`, { token })).body;
    assert.equal(collection.franchise, "The Fake");
    assert.deepEqual(collection.movies.map((movie) => movie.title), ["The Fake Film", "The Fake Sequel"]);
    assert.equal((await api("GET", "/movies/collections/12345", { token })).status, 404);
  });

  test("more like this: scored from the pool, with reasons", async () => {
    // Batman Begins (Nolan) — in the pool; TMDB has no recommendations for
    // it here, so it's the pool alone.
    const like = await api("GET", "/movies/272/like", { token });
    assert.equal(like.status, 200);
    const { similar, movies } = like.body;
    assert.ok(similar.length > 0 && similar.length <= 20);
    assert.ok(!similar.some((item) => item.id === "272"), "never itself");
    const byId = new Map(movies.map((movie) => [movie.id, movie]));
    assert.ok(similar.every((item) => byId.has(item.id)), "the movies come with it");
    assert.ok(
      similar.every((item) => byId.get(item.id).director !== "Christopher Nolan"),
      "the director's films are left to \"Also by\"",
    );
    assert.ok(similar.every((item) => Array.isArray(item.reasons)));
    assert.ok(
      similar.every((item) => item.percent >= 1 && item.percent <= 99 && item.signals.feel >= 0 && item.shared),
      "each says how similar, and in what",
    );
    assert.ok(byId.has("272"), "the movie itself comes too");
    assert.equal((await api("GET", "/movies/272/like?count=5", { token })).body.similar.length, 5);
    const scores = similar.map((item) => item.score);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x), "best first");
    assert.equal((await api("GET", "/movies/272/like")).status, 401);
  });

  test("people: search, and a filmography split by role", async () => {
    const found = (await api("GET", "/people/search?q=dee", { token })).body;
    assert.equal(found.results[0].name, "Dee Director");
    assert.deepEqual(found.results[0].knownForTitles, ["The Fake Film"]);
    const { person } = (await api("GET", `/people/${FAKE_PERSON_ID}`, { token })).body;
    assert.equal(person.biography, "Makes fake films.");
    assert.equal(person.acting[0].character, "Cameo");
    assert.deepEqual(person.directing.map((movie) => movie.title), ["The Fake Film"]);
    assert.deepEqual(person.directing[0].jobs, ["Director", "Writer"]);
    assert.deepEqual(person.otherCrew.map((movie) => movie.title), ["The Fake Sequel"]);
    assert.equal((await api("GET", "/people/1234", { token })).status, 404);
  });

  test("batch, and TMDB being down", async () => {
    const batch = (await api("GET", `/movies/batch?ids=${FAKE_MOVIE_ID},999999999,289`, { token })).body;
    assert.deepEqual(batch.movies.map((movie) => movie.id), [FAKE_MOVIE_ID, "289"], "unknown ones are left out");

    const url = process.env.TMDB_API_URL;
    process.env.TMDB_API_URL = "http://127.0.0.1:9"; // nothing listens there
    try {
      assert.equal((await api("GET", `/movies/${FAKE_MOVIE_ID}`, { token })).status, 200, "the server's copy will do");
      assert.equal((await api("GET", "/movies/289", { token })).status, 200, "pool movies never need TMDB");
      const missing = await api("POST", "/me/watchlist", { token, body: { movieId: "31337" } });
      assert.equal(missing.status, 503, "a movie it has never seen can't be fetched");
    } finally {
      process.env.TMDB_API_URL = url;
    }
  });
});
