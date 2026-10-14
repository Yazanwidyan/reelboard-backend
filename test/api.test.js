import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { verifiers } from "../src/lib/social.js";

let server;
let base;

before(async () => {
  openDatabase(":memory:");
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  closeDatabase();
});

const api = async (method, path, { token, body } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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
    assert.equal(all.body.total, 250);
    assert.equal(all.body.movies[0].id, "m1");

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

    const ids = await api("GET", "/movies?ids=m3,m1,m2");
    assert.deepEqual(ids.body.movies.map((movie) => movie.id), ["m3", "m1", "m2"]);

    const one = await api("GET", "/movies/m1");
    assert.equal(one.body.movie.title, "Casablanca");
    assert.equal(one.body.movie.vibe.dims.length, 6);
    assert.equal((await api("GET", "/movies/m9999")).status, 404);

    const meta = await api("GET", "/movies/meta");
    assert.ok(meta.body.genres.includes("Drama"));
    assert.equal(meta.body.dimensions.length, 6);

    const reels = await api("GET", "/movies/reels");
    assert.ok(reels.body.clips.length > 0);
    assert.ok(reels.body.clips[0].movie.title);

    assert.equal((await api("GET", "/movies?decade=1850s")).status, 400);

    const catalog = await api("GET", "/movies/catalog");
    assert.equal(catalog.body.movies.length, 250);
    assert.equal(catalog.body.movies[0].vibe.dims.length, 6);
    assert.ok(catalog.body.movies.every((movie) => Array.isArray(movie.cast)));
    assert.ok(catalog.body.reelClips.length > 0);
    assert.deepEqual(Object.keys(catalog.body.reelClips[0]).sort(), ["end", "movieId", "start", "youtubeId"]);
    assert.equal(catalog.body.dimensions.length, 6);
    assert.ok(catalog.body.themes.twist);
  });
});

describe("library", () => {
  let token;
  before(async () => {
    ({ token } = await register("Lib User", "libuser"));
  });

  test("watchlist → pick → watched clears both and completes the challenge", async () => {
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "m5" } })).status, 201);
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "m5" } })).status, 200);
    assert.equal((await api("POST", "/me/watchlist", { token, body: { movieId: "m99999" } })).status, 400);

    await api("PUT", "/me/pick", { token, body: { movieId: "m5", mood: "cozy" } });
    const pick = await api("GET", "/me/pick", { token });
    assert.deepEqual(pick.body, { pickedMovie: "m5", pickMood: { movieId: "m5", mood: "cozy" } });

    const accepted = await api("POST", "/me/challenges/active", {
      token,
      body: { challenge: { id: "c-1", type: "decade", title: "Go old", targetMovieId: "m5", xpReward: 120 } },
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.activeChallenge.title, "Go old");

    const watched = await api("POST", "/me/watched", { token, body: { movieId: "m5", tier: "A" } });
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
  });

  test("tier, date, rewatch and unwatch", async () => {
    await api("POST", "/me/watched", { token, body: { movieId: "m7" } });

    const future = Date.now() + 1e9;
    const patched = await api("PATCH", "/me/watched/m7", { token, body: { tier: "S", watchedAt: future } });
    assert.equal(patched.body.entry.tier, "S");
    assert.ok(patched.body.entry.timestamp <= Date.now(), "never in the future");

    assert.equal((await api("PATCH", "/me/watched/m7", { token, body: { tier: "Z" } })).status, 400);
    assert.equal((await api("PATCH", "/me/watched/m8", { token, body: { tier: "S" } })).status, 404);

    const rewatch = await api("POST", "/me/watched/m7/rewatch", { token });
    assert.equal(rewatch.body.entry.watchCount, 2);

    assert.equal((await api("DELETE", "/me/watched/m7", { token })).status, 204);
    assert.equal((await api("DELETE", "/me/watched/m7", { token })).status, 404);
  });

  test("recommendations skip watched movies and honour the count", async () => {
    const recs = await api("GET", "/me/recommendations?count=12", { token });
    assert.equal(recs.body.movies.length, 12);
    assert.ok(!recs.body.movies.some((movie) => movie.id === "m5"));
  });

  test("unlocked collections, top ten, pinned, profile, settings, searches", async () => {
    let r = await api("PUT", "/me/unlocked-collections/director-nolan", { token });
    assert.deepEqual(r.body.unlockedCollections, ["director-nolan"]);
    r = await api("DELETE", "/me/unlocked-collections/director-nolan", { token });
    assert.deepEqual(r.body.unlockedCollections, []);

    r = await api("PUT", "/me/top-ten", { token, body: { movieIds: ["m3", "m1"] } });
    assert.deepEqual(r.body.topTen, ["m3", "m1"]);
    assert.equal((await api("PUT", "/me/top-ten", { token, body: { movieIds: ["m1", "m1"] } })).status, 400);

    r = await api("PUT", "/me/pinned-collections", { token, body: { collectionIds: ["a", "b", "c", "d"] } });
    assert.equal(r.status, 400);

    r = await api("PATCH", "/me/profile", { token, body: { bio: "Film nerd", level: 4, xp: 2400 } });
    assert.equal(r.body.profile.bio, "Film nerd");
    assert.equal(r.body.profile.level, 4);

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
    await api("PUT", "/me/taste/aspects/m5", { token, body: { aspects: ["the twist", "the twist"] } });
    await api("POST", "/me/taste/passes", { token, body: { movieId: "m9" } });
    const taste = await api("GET", "/me/taste", { token });
    assert.deepEqual(taste.body.leanings, [1, 0, -1, 0, 1, 0]);
    assert.deepEqual(taste.body.aspects, { m5: ["the twist"] });
    assert.equal(taste.body.passes[0].movieId, "m9");
    assert.equal((await api("PUT", "/me/taste/leanings", { token, body: { leanings: [2] } })).status, 400);
  });
});

describe("boards", () => {
  test("create, add, reorder, rename, remove, delete", async () => {
    const { token } = await register("Board User", "boarduser");
    const created = await api("POST", "/boards", { token, body: { name: "  Rainy day  ", movieIds: ["m1"] } });
    assert.equal(created.status, 201);
    const { id } = created.body.board;
    assert.equal(created.body.board.name, "Rainy day");

    let r = await api("POST", `/boards/${id}/movies`, { token, body: { movieId: "m2" } });
    r = await api("POST", `/boards/${id}/movies`, { token, body: { movieId: "m2" } });
    assert.deepEqual(r.body.board.movieIds, ["m1", "m2"]);

    r = await api("PUT", `/boards/${id}/movies`, { token, body: { movieIds: ["m2", "m1", "m3"] } });
    assert.deepEqual(r.body.board.movieIds, ["m2", "m1", "m3"]);

    r = await api("PATCH", `/boards/${id}`, { token, body: { name: "x".repeat(41) } });
    assert.equal(r.status, 400);
    r = await api("PATCH", `/boards/${id}`, { token, body: { name: "Date night" } });
    assert.equal(r.body.board.name, "Date night");

    r = await api("DELETE", `/boards/${id}/movies/m1`, { token });
    assert.deepEqual(r.body.board.movieIds, ["m2", "m3"]);

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
  });
});

describe("friends and activity", () => {
  test("request, accept, see their library and feed; strangers see nothing", async () => {
    const sam = await register("Sam Rivera", "samr");
    const omar = await register("Omar Saleh", "omar");
    const stranger = await register("Stranger", "stranger");

    const board = await api("POST", "/boards", { token: sam.token, body: { name: "Sci-fi" } });
    await api("POST", "/me/watched", { token: sam.token, body: { movieId: "m143", tier: "S" } });
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
      [{ movieId: "m143", tier: "S" }],
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
    await api("PATCH", "/me/watched/m143", { token: sam.token, body: { tier: "A" } });
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
          bucketList: [{ movieId: "m10", addedAt: 1700000000000 }, { movieId: "m0000", addedAt: 1 }],
          watched: [
            { movieId: "m1", timestamp: 1700000000000, tier: "S", watchCount: 3 },
            { movieId: "m2", timestamp: 1700000001000, rating: 4.5 },
            "garbage",
          ],
          pickedMovie: "m10",
          pickMood: { movieId: "m10", mood: "epic" },
          unlockedCollections: ["decade-1990s"],
        },
        boardStore: { boards: [{ id: "bxyz", name: "Old board", movieIds: ["m1", "m2", "m77777"], createdAt: 1 }] },
        profileStore: { displayName: "You", bio: "hi", topTen: ["m1"], pinnedCollections: [] },
        userStore: { preferences: { decade: "1990s" }, hasCompletedOnboarding: true },
        tasteStore: { aspects: { m1: ["the twist"] }, passes: [{ movieId: "m3", at: 5 }], leanings: null },
        challengeStore: {
          activeChallenge: { id: "c-2", targetMovieId: "m10", title: "Watch it" },
          history: [{ id: "c-1", targetMovieId: "m1", status: "completed", resolvedAt: 10 }],
        },
        languageStore: { language: "ar" },
        themeStore: { mode: "dark" },
        tipsStore: { seen: { swipe: true } },
        recentSearchStore: { recentSearches: ["kubrick"] },
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const state = r.body;
    assert.deepEqual(state.library.bucketList.map((e) => e.movieId), ["m10"]);
    assert.equal(state.library.watched.length, 2);
    assert.equal(state.library.watched.find((e) => e.movieId === "m1").watchCount, 3);
    assert.equal(state.library.watched.find((e) => e.movieId === "m2").rating, 4.5);
    assert.deepEqual(state.library.pickMood, { movieId: "m10", mood: "epic" });
    assert.deepEqual(state.boards[0].movieIds, ["m1", "m2"]);
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
