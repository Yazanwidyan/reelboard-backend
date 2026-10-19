import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import { FAKE_MOVIE_ID, startFakeTmdb } from "./fakeTmdb.js";

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

  test("sagas: edit, create, delete — live, in curation.json, and XP follows", async () => {
    const list = await api("GET", "/admin/sagas", { token: boss.token });
    assert.equal(list.body.sagas[0].id, SAGA.id);
    assert.equal(list.body.sagas[0].started, 1);

    // The regular user has watched The Dark Knight: one rank (Citizen).
    const xpBefore = (await api("GET", "/me/profile", { token: regular.token })).body.profile.xp;
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
    assert.equal((await api("GET", "/me/profile", { token: regular.token })).body.profile.xp, xpBefore, "still one rank");

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
    // The Dark Knight now reaches Dreamer too: +150.
    assert.equal((await api("GET", "/me/profile", { token: regular.token })).body.profile.xp, xpBefore + 150);
    assert.equal((await api("POST", "/admin/sagas", { token: boss.token, body: { ...created.body.saga, id: "nolan-starter" } })).status, 400);

    assert.equal((await api("DELETE", "/admin/sagas/saga-nolan-starter", { token: boss.token })).status, 204);
    assert.ok(!curation().sagas.some((item) => item.id === "nolan-starter"));
    assert.equal((await api("GET", "/me/profile", { token: regular.token })).body.profile.xp, xpBefore);
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
