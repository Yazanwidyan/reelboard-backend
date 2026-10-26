import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import { FAKE_COLLECTION_ID, FAKE_MOVIE_ID, startFakeTmdb } from "./fakeTmdb.js";

// The admin API (/api/admin), against the test pool, a fake TMDB and a copy
// of data/curation.json — the admin site writes curation, and the real file
// must stay untouched.

const POOL = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/pool.json.gz", import.meta.url))).toString("utf8"),
);
const SAGA = {
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
  art: null,
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reelboard-admin-"));
const curationCopy = path.join(tempDir, "curation.json");
fs.copyFileSync(new URL("../data/curation.json", import.meta.url), curationCopy);
const curation = () => JSON.parse(fs.readFileSync(curationCopy, "utf8"));

let server;
let base;
let tmdb;
let db;

before(async () => {
  tmdb = await startFakeTmdb();
  process.env.TMDB_API_URL = tmdb.url;
  process.env.TMDB_READ_TOKEN = "test-token";
  process.env.CURATION_PATH = curationCopy;
  process.env.ADMIN_EMAILS = "Boss@Example.com";
  // Imported now, so config reads the variables above.
  db = await import("../src/db/index.js");
  const { createApp } = await import("../src/app.js");
  db.openDatabase(":memory:");
  db.writePool(POOL);
  db.writeSagas([SAGA]);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  tmdb.close();
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const api = async (method, path_, { token, body } = {}) => {
  const response = await fetch(base + path_, {
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

const register = async (name, handle, email = `${handle}@example.com`) => {
  const { status, body } = await api("POST", "/auth/register", {
    body: { email, password: "password123", displayName: name, handle },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
};

describe("admin", () => {
  let boss;
  let regular;
  before(async () => {
    boss = await register("The Boss", "theboss", "boss@example.com");
    regular = await register("Regular Joe", "regularjoe");
  });

  test("only ADMIN_EMAILS get in", async () => {
    assert.equal((await api("GET", "/admin/stats")).status, 401);
    assert.equal((await api("GET", "/admin/stats", { token: regular.token })).status, 403);
    const me = await api("GET", "/admin/me", { token: boss.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "boss@example.com", "matched case-insensitively");
  });

  test("dashboard numbers", async () => {
    await api("POST", "/me/watched", { token: regular.token, body: { movieId: "155", tier: "S" } });
    const { body } = await api("GET", "/admin/stats", { token: boss.token });
    assert.equal(body.users.total, 2);
    assert.equal(body.users.new7, 2);
    assert.equal(body.users.active7, 1);
    assert.equal(body.signups.length, 30);
    assert.equal(body.signups.at(-1).count, 2);
    assert.equal(body.totals.watched, 1);
    assert.equal(body.totals.poolMovies, POOL.length);
    assert.equal(body.topWatched[0].id, "155");
    assert.equal(body.topS[0].title, "The Dark Knight");
    assert.deepEqual(body.sagas[0], { id: SAGA.id, title: SAGA.title, kind: "franchise", films: 3, started: 1, finished: 0 });
  });

  test("users: search, detail, delete (not yourself)", async () => {
    const found = await api("GET", "/admin/users?q=regular", { token: boss.token });
    assert.deepEqual(found.body.users.map((user) => user.handle), ["@regularjoe"]);
    assert.equal(found.body.users[0].watchedCount, 1);
    const detail = await api("GET", `/admin/users/${regular.user.id}`, { token: boss.token });
    assert.equal(detail.body.counts.watched, 1);
    assert.equal(detail.body.tiers.S, 1);
    assert.equal(detail.body.activity[0].movieId, "155");
    assert.equal((await api("DELETE", `/admin/users/${boss.user.id}`, { token: boss.token })).status, 400);
  });

  test("movies: list, hand-tune a vibe and franchise — in the database and curation.json", async () => {
    const list = await api("GET", "/admin/movies?scope=pool&limit=5", { token: boss.token });
    assert.equal(list.body.movies.length, 5);
    assert.equal(list.body.total, POOL.length);
    assert.ok(list.body.movies.every((movie) => movie.inPool));
    const search = await api("GET", "/admin/movies?q=dark%20knight&scope=all", { token: boss.token });
    assert.ok(search.body.movies.some((movie) => movie.id === "155"));

    const vibe = { dims: [5, 5, 5, 5, 5, 5], themes: ["twist"] };
    const saved = await api("PATCH", "/admin/movies/155", { token: boss.token, body: { vibe, franchise: "Batman" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.movie.vibe, vibe);
    assert.equal(saved.body.movie.vibeSource, "hand");
    assert.equal(saved.body.movie.franchise, "Batman");
    const entry = curation().movies.find((item) => item.id === "155");
    assert.deepEqual(entry.vibe, vibe);
    assert.equal(entry.franchise, "Batman");
    assert.equal(
      (await api("PATCH", "/admin/movies/155", { token: boss.token, body: { vibe: { dims: [1, 1, 1, 1, 1, 1], themes: ["nope"] } } })).status,
      400,
    );
  });

  test("movies: into and out of the pool", async () => {
    // A movie the server has never seen: fetched from TMDB, into the pool.
    const added = await api("PATCH", `/admin/movies/${FAKE_MOVIE_ID}`, { token: boss.token, body: { inPool: true } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.movie.inPool, true);
    assert.ok(curation().movies.some((item) => item.id === FAKE_MOVIE_ID));
    const pool = await api("GET", "/admin/stats", { token: boss.token });
    assert.equal(pool.body.totals.poolMovies, POOL.length + 1);

    // Out again: off the curated list, and kept out by build-pool.
    const removed = await api("PATCH", `/admin/movies/${FAKE_MOVIE_ID}`, { token: boss.token, body: { inPool: false } });
    assert.equal(removed.body.movie.inPool, false);
    assert.ok(!curation().movies.some((item) => item.id === FAKE_MOVIE_ID));
    assert.ok(curation().excluded.includes(FAKE_MOVIE_ID));
    const back = await api("PATCH", `/admin/movies/${FAKE_MOVIE_ID}`, { token: boss.token, body: { inPool: true } });
    assert.equal(back.body.movie.inPool, true);
    assert.equal(curation().excluded, undefined, "no longer excluded");
  });

  test("sagas: edit, create, delete — live, in curation.json; ranks don't move", async () => {
    const list = await api("GET", "/admin/sagas", { token: boss.token });
    assert.equal(list.body.sagas[0].id, SAGA.id);
    assert.equal(list.body.sagas[0].started, 1);

    // The regular user has watched The Dark Knight: one rank (Citizen).
    const ranks = async () => (await api("GET", "/me/profile", { token: regular.token })).body.profile.ranks;
    const ranksBefore = await ranks();
    const edited = await api("PATCH", `/admin/sagas/${SAGA.id}`, {
      token: boss.token,
      body: { title: "Bat-Fan", ranks: [{ title: "Citizen", at: 1 }, { title: "Vigilante", at: 3 }] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.saga.title, "Bat-Fan");
    assert.deepEqual(edited.body.saga.ranks.map((rank) => rank.at), [1, 3]);
    const curated = curation().sagas.find((item) => item.id === "gothams-guardian");
    assert.equal(curated.title, "Bat-Fan");
    assert.deepEqual(curated.ranks.at(-1), { title: "Vigilante", at: "all" });
    // The app gets the new version at once.
    const featured = await api("GET", "/collections", { token: regular.token });
    assert.equal(featured.body.collections[0].title, "Bat-Fan");
    assert.equal(await ranks(), ranksBefore, "still one rank");

    // A rank needing more films than the saga has is refused.
    assert.equal(
      (await api("PATCH", `/admin/sagas/${SAGA.id}`, { token: boss.token, body: { ranks: [{ title: "Too far", at: 9 }, { title: "x", at: 10 }] } })).status,
      400,
    );

    const created = await api("POST", "/admin/sagas", {
      token: boss.token,
      body: {
        id: "nolan-starter",
        title: "Nolan Starter",
        kind: "director",
        movieIds: ["155", "27205", "157336"],
        ranks: [{ title: "Dreamer", at: 1 }, { title: "Architect", at: 3 }],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok(created.body.saga.art?.backdrop);
    assert.ok(curation().sagas.some((item) => item.id === "nolan-starter" && item.from.ids.length === 3));
    // The Dark Knight now reaches Dreamer too — a saga's ladder, not a rank.
    assert.equal(await ranks(), ranksBefore);
    assert.equal((await api("POST", "/admin/sagas", { token: boss.token, body: { ...created.body.saga, id: "nolan-starter" } })).status, 400);

    assert.equal((await api("DELETE", "/admin/sagas/saga-nolan-starter", { token: boss.token })).status, 204);
    assert.ok(!curation().sagas.some((item) => item.id === "nolan-starter"));
    assert.equal(await ranks(), ranksBefore);
  });

  test("sagas: rules previewed from TMDB, ranks by share, a picked cover", async () => {
    const preview = await api("POST", "/admin/sagas/preview", {
      token: boss.token,
      body: { from: { tmdbCollections: [Number(FAKE_COLLECTION_ID)] } },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.source, "The Fake Collection");
    assert.ok(preview.body.movies.some((movie) => movie.id === FAKE_MOVIE_ID));
    // Films picked one by one aren't a rule.
    assert.equal((await api("POST", "/admin/sagas/preview", { token: boss.token, body: { from: { ids: ["1"] } } })).status, 400);

    const people = await api("GET", "/admin/tmdb/search?type=person&q=dee", { token: boss.token });
    assert.equal(people.status, 200, JSON.stringify(people.body));
    assert.equal(people.body.results[0].name, "Dee Director");
    assert.ok(people.body.results[0].image.startsWith("https://image.tmdb.org/"));

    const cover = { backdrop: "https://image.tmdb.org/t/p/w1280/picked.jpg" };
    const edited = await api("PATCH", `/admin/sagas/${SAGA.id}`, {
      token: boss.token,
      body: { ranks: [{ title: "Citizen", share: 0.5 }, { title: "Gotham's Guardian" }], art: cover },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.saga.ranks.map((rank) => rank.at), [2, 3]);
    assert.deepEqual(edited.body.saga.art, cover);
    const curated = () => curation().sagas.find((item) => item.id === "gothams-guardian");
    assert.deepEqual(curated().ranks, [{ title: "Citizen", share: 0.5 }, { title: "Gotham's Guardian", at: "all" }]);
    assert.deepEqual(curated().art, cover);
    // Back to automatic: the pick is forgotten.
    const automatic = await api("PATCH", `/admin/sagas/${SAGA.id}`, { token: boss.token, body: { art: null } });
    assert.equal(automatic.status, 200, JSON.stringify(automatic.body));
    assert.notDeepEqual(automatic.body.saga.art, cover);
    assert.equal(curated().art, undefined);
    // Images from anywhere but TMDB are refused.
    assert.equal(
      (await api("PATCH", `/admin/sagas/${SAGA.id}`, { token: boss.token, body: { art: { backdrop: "https://example.com/x.jpg" } } })).status,
      400,
    );
  });

  test("suspend: no sign-in, no sessions, hidden from others — until unsuspended", async () => {
    const suspect = await register("Sus Pect", "suspect");
    await api("POST", "/friends/requests", { token: suspect.token, body: { userId: regular.user.id } });
    await api("POST", `/friends/requests/${suspect.user.id}/accept`, { token: regular.token });
    const friendIds = async () => (await api("GET", "/friends", { token: regular.token })).body.friends.map((friend) => friend.id);
    assert.deepEqual(await friendIds(), [suspect.user.id]);

    // Not yourself, not another admin.
    assert.equal((await api("POST", `/admin/users/${boss.user.id}/suspend`, { token: boss.token, body: {} })).status, 400);

    const suspended = await api("POST", `/admin/users/${suspect.user.id}/suspend`, { token: boss.token, body: { reason: "Spam lists" } });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.suspension.reason, "Spam lists");
    // Its session stops working, and it can't sign in again.
    assert.equal((await api("GET", "/me", { token: suspect.token })).status, 401);
    const login = await api("POST", "/auth/login", { body: { email: "suspect@example.com", password: "password123" } });
    assert.equal(login.status, 403);
    assert.match(login.body.error.message, /suspended/);
    // Nobody else sees it.
    assert.deepEqual((await api("GET", "/users/search?q=suspect", { token: regular.token })).body.users, []);
    assert.equal((await api("GET", `/users/${suspect.user.id}`, { token: regular.token })).status, 404);
    assert.deepEqual(await friendIds(), []);
    // The admin does: in the list (filtered too) and on its page.
    const list = await api("GET", "/admin/users?status=suspended", { token: boss.token });
    assert.deepEqual(list.body.users.map((user) => user.handle), ["@suspect"]);
    const detail = await api("GET", `/admin/users/${suspect.user.id}`, { token: boss.token });
    assert.equal(detail.body.suspension.reason, "Spam lists");

    assert.equal((await api("DELETE", `/admin/users/${suspect.user.id}/suspend`, { token: boss.token })).status, 200);
    assert.equal((await api("POST", "/auth/login", { body: { email: "suspect@example.com", password: "password123" } })).status, 200);
    assert.deepEqual(await friendIds(), [suspect.user.id], "friendships come back");
    assert.equal((await api("DELETE", `/admin/users/${suspect.user.id}`, { token: boss.token })).status, 204);
  });

  test("content: clean a profile, remove a list, a club's film and description", async () => {
    await api("PATCH", "/me/profile", { token: regular.token, body: { bio: "Buy followers at spam.example", avatarUri: "https://example.com/a.jpg" } });
    const cleaned = await api("POST", `/admin/users/${regular.user.id}/clean`, { token: boss.token, body: { bio: true, avatar: true, name: true } });
    assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
    assert.equal(cleaned.body.user.bio, "");
    assert.equal(cleaned.body.user.avatarUri, null);
    assert.equal(cleaned.body.user.displayName, "regularjoe");
    assert.equal((await api("POST", `/admin/users/${regular.user.id}/clean`, { token: boss.token, body: {} })).status, 400);

    const list = await api("POST", "/boards", { token: regular.token, body: { name: "Rude name", movieIds: ["155"] } });
    const detail = await api("GET", `/admin/users/${regular.user.id}`, { token: boss.token });
    assert.deepEqual(detail.body.lists.map((item) => [item.name, item.movieCount]), [["Rude name", 1]]);
    assert.equal((await api("DELETE", `/admin/boards/${list.body.board.id}`, { token: boss.token })).status, 204);
    assert.deepEqual((await api("GET", "/boards", { token: regular.token })).body.boards, []);
    assert.equal((await api("DELETE", `/admin/boards/${list.body.board.id}`, { token: boss.token })).status, 404);

    const created = await api("POST", "/clubs", { token: regular.token, body: { name: "Spam Club", description: "Click here" } });
    const clubId = created.body.club.id;
    await api("POST", `/clubs/${clubId}/movies`, { token: regular.token, body: { movieId: "155" } });
    const club = await api("GET", `/admin/clubs/${clubId}`, { token: boss.token });
    assert.equal(club.status, 200, JSON.stringify(club.body));
    assert.equal(club.body.members[0].role, "owner");
    assert.equal(club.body.movies[0].addedBy.handle, "@regularjoe");
    assert.equal((await api("DELETE", `/admin/clubs/${clubId}/movies/155`, { token: boss.token })).status, 204);
    const patched = await api("PATCH", `/admin/clubs/${clubId}`, { token: boss.token, body: { description: "" } });
    assert.equal(patched.body.club.description, "");
    const after_ = (await api("GET", `/admin/clubs/${clubId}`, { token: boss.token })).body;
    assert.deepEqual(after_.movies, []);
    assert.equal((await api("DELETE", `/admin/clubs/${clubId}`, { token: boss.token })).status, 204);
  });

  test("reports: from the app, into the queue by target, closed by an action — all in the log", async () => {
    const reporter = await register("Rita Reporter", "rita");
    await api("POST", "/friends/requests", { token: reporter.token, body: { userId: regular.user.id } });
    await api("POST", `/friends/requests/${reporter.user.id}/accept`, { token: regular.token });
    const list = (await api("POST", "/boards", { token: regular.token, body: { name: "Buy followers here" } })).body.board;
    const report = (body, token = reporter.token) => api("POST", "/reports", { token, body });

    // Only what you can see, never your own.
    assert.equal((await report({ targetType: "user", targetId: reporter.user.id, reason: "spam" })).status, 400);
    assert.equal((await report({ targetType: "list", targetId: list.id, reason: "spam" }, regular.token)).status, 400);
    assert.equal((await report({ targetType: "club", targetId: "c_nope", reason: "spam" })).status, 404);
    assert.equal((await report({ targetType: "list", targetId: list.id, reason: "nonsense" })).status, 400);

    const first = await report({ targetType: "list", targetId: list.id, reason: "spam", note: "It's an ad" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // Again while open: nothing new.
    const again = await report({ targetType: "list", targetId: list.id, reason: "offensive" });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyReported, true);
    assert.equal((await report({ targetType: "user", targetId: regular.user.id, reason: "harassment" })).status, 201);

    // The queue: one case per target, with what it is now.
    const queue = await api("GET", "/admin/reports", { token: boss.token });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.equal(queue.body.open, 2);
    const listCase = queue.body.cases.find((item) => item.targetType === "list");
    assert.equal(listCase.label, "Buy followers here");
    assert.equal(listCase.owner.handle, "@regularjoe");
    assert.equal(listCase.reports[0].note, "It's an ad");
    assert.equal(listCase.reports[0].reporter.handle, "@rita");
    assert.equal((await api("GET", "/admin/reports/count", { token: boss.token })).body.open, 2);

    // Close the list's case by removing it; a person can't be "removed".
    assert.equal(
      (await api("POST", "/admin/reports/resolve", { token: boss.token, body: { targetType: "user", targetId: regular.user.id, action: "remove" } })).status,
      400,
    );
    const removed = await api("POST", "/admin/reports/resolve", {
      token: boss.token,
      body: { targetType: "list", targetId: list.id, action: "remove" },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.open, 1);
    assert.deepEqual((await api("GET", "/boards", { token: regular.token })).body.boards, []);
    const dismissed = await api("POST", "/admin/reports/resolve", {
      token: boss.token,
      body: { targetType: "user", targetId: regular.user.id, action: "dismiss", note: "A joke between friends" },
    });
    assert.equal(dismissed.body.resolution, "Dismissed — A joke between friends");
    const history = await api("GET", "/admin/reports?status=actioned", { token: boss.token });
    assert.equal(history.body.cases[0].resolution, "Removed the list");
    assert.equal(history.body.cases[0].gone, true);
    assert.equal(history.body.cases[0].resolvedBy.handle, "@theboss");
    // Closed: it can be reported again.
    assert.equal((await report({ targetType: "user", targetId: regular.user.id, reason: "spam" })).status, 201);
    assert.equal(
      (await api("POST", "/admin/reports/resolve", { token: boss.token, body: { targetType: "user", targetId: regular.user.id, action: "handled" } })).status,
      200,
    );

    // The log: newest first, filterable by kind.
    const logged = await api("GET", "/admin/log", { token: boss.token });
    assert.equal(logged.status, 200, JSON.stringify(logged.body));
    assert.equal(logged.body.entries[0].action, "report.handled");
    assert.equal(logged.body.entries[0].admin.email, "boss@example.com");
    assert.ok(logged.body.entries.some((entry) => entry.summary === `Removed @regularjoe's list "Buy followers here"`));
    assert.ok(logged.body.entries.some((entry) => entry.action === "user.suspend" && entry.summary.startsWith("Suspended @suspect")));
    const reportsOnly = await api("GET", "/admin/log?action=report", { token: boss.token });
    assert.ok(reportsOnly.body.entries.every((entry) => entry.action.startsWith("report.")));
    assert.equal(reportsOnly.body.total, 3);

    assert.equal((await api("DELETE", `/admin/users/${reporter.user.id}`, { token: boss.token })).status, 204);
  });

  test("clubs: list and remove", async () => {
    await api("POST", "/clubs", { token: regular.token, body: { name: "Joe's Club" } });
    const clubs = await api("GET", "/admin/clubs", { token: boss.token });
    assert.equal(clubs.body.clubs.length, 1);
    assert.equal(clubs.body.clubs[0].owner.handle, "@regularjoe");
    assert.equal(clubs.body.clubs[0].memberCount, 1);
    assert.equal((await api("DELETE", `/admin/clubs/${clubs.body.clubs[0].id}`, { token: boss.token })).status, 204);
    assert.deepEqual((await api("GET", "/clubs", { token: regular.token })).body.clubs, []);

    // And a user can be deleted.
    assert.equal((await api("DELETE", `/admin/users/${regular.user.id}`, { token: boss.token })).status, 204);
    assert.equal((await api("GET", "/admin/stats", { token: boss.token })).body.users.total, 1);
  });
});
