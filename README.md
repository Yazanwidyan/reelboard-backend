# ReelBoard Backend

REST API for the [ReelBoard](../Reelboard) app. It handles accounts, movies (any movie on TMDB: search, pages, browsing, people), your library (watchlist, watched + tiers, tonight's pick), boards, challenges, taste signals, settings, friends, clubs and the activity feed.

It's built with Node.js, Express 5 and SQLite (Node's built-in `node:sqlite`, so there's no database server to install), plus JWT auth and zod validation.

## Getting started

```bash
npm install
cp .env.example .env      # then set JWT_SECRET and TMDB_READ_TOKEN
npm run build-pool        # puts ~8,000 movies from TMDB into the database (a few minutes, once)
npm run dev               # http://localhost:4000/api, restarts on changes
npm test                  # end-to-end tests against an in-memory database
```

The database file is created at `data/reelboard.db` (set `DATABASE_PATH` to put it elsewhere). It holds everything, the movies included; nothing is read from big files at start-up.

**Upgrading from before TMDB:** a database from when movies had ids like `m42` can't be used any more, and the server says so at start-up. Stop the server, delete `data/reelboard.db` (and its `-wal` / `-shm` files) and start again. This deletes all accounts.

### Movies: TMDB and the pool

Every movie comes from [TMDB](https://www.themoviedb.org), whose API terms allow apps to use its data and images. A movie's id is its TMDB id, as a string (`"603"` is The Matrix). Put your TMDB **API Read Access Token** in `.env` as `TMDB_READ_TOKEN` (or the API key as `TMDB_API_KEY`). It stays on the server; the app never sees it.

There are two kinds of movies:

- **The pool** (in the database's `movies` table, `in_pool = 1`): TMDB's well-known movies, about 8,000 (everything with 500+ votes, plus curated seeds), each with a Taste DNA vibe (`{ dims: [6 × 1–5], themes }`). 250 were tuned by hand (`vibeSource: "hand"`); the rest are estimated by a model learnt from those. Candidates (what the app swipes, spins and picks from) and collections come from the pool.
- **Everything else on TMDB:** found with search or browsing. The server fetches a movie the first time someone opens or saves it, keeps it in the `movies` table with an estimated vibe, and refreshes it when it's more than a week old. Any movie can be watched, tiered, saved, put on a board or added to a club.

**The app doesn't download the pool.** It gets:
- **Candidates:** `GET /api/me/candidates` picks a few hundred movies from the whole pool for the person's taste and filters (`src/lib/candidates.js`). The app keeps them in memory; nothing is saved on the phone.
- **The movies each response mentions:** responses that carry movie ids (`/me`, `/me/library`, `/friends`, `/activity`, `/boards`, clubs, trending, `/movies/reels`) also carry a `movies` list with those movies.
- **Collections as definitions** (see Collections below), with "cards" for their films: `{ id, title, year, rating, runtime, genres, director, cast, franchise, poster, rank, partial: true }`, enough for a poster. The app fetches the full movie when it opens one.

**Building the pool** (into the database; git keeps only what people chose by hand):

```bash
npm run build-pool                 # curated + seeds + every TMDB movie with 500+ votes
npm run build-pool -- --grow 500   # only up to 500 beyond the curated ones and seeds
npm run build-pool -- --offline    # cached TMDB answers only, no requests
```

- **`data/curation.json`** (in git, about 80 KB): the curated list in rank order, with the 250 hand-tuned vibes and hand-set franchises, plus the Taste DNA vocabulary and the Reels clips. The server reads the vocabulary and clips from it on start. Everything else about a movie (title, year, rating, runtime, genres, director, cast and crew, plot, poster, backdrop, trailer, age rating) comes from TMDB.
- **Order:** the curated list first, then new seeds, then TMDB's most-voted movies. That's the movies' `rank`.
- **Seeds:** `data/seed-movies.txt` lists movies for the pool, one per line as `Title|Year|Franchise|imdbId`. Franchise and IMDb id are optional; an IMDb id pins the exact film when a title is ambiguous. Seeds not in the pool yet are added; seeds already in it get their franchise set. The script lists any seed TMDB can't find.
- **Cache:** TMDB's answers are kept in `data/tmdb-cache.json` (not committed), so re-runs only ask about what's new.
- **Time:** a first run asks TMDB about ~8,000 movies, a few minutes; later runs only ask about new ones.
- **Afterwards:** restart the server (it reads the pool once). Candidates and collections come from the new pool straight away; the app gets new candidates the next time it asks (when they're 12 hours old, or the filters change).

**Ratings:** `rating` is TMDB's average vote (0–10), alongside ReelBoard's own community tiers. IMDb, Rotten Tomatoes and Metacritic scores aren't used, because they aren't licensed for an app like this.

**Attribution:** TMDB's terms require crediting it wherever its data appears; the app's Settings screen does. "Where to watch" data is JustWatch's (through TMDB), and JustWatch must be credited wherever it's shown.

## Conventions

- **Auth:** send `Authorization: Bearer <token>`. `register` and `login` return `{ token, user }`.
- **Timestamps:** milliseconds since the epoch, the same as `Date.now()` in the app.
- **Movie ids:** TMDB ids, as strings (`"603"`). Each movie's IMDb id is in `details.imdbId`.
- **Response shapes:** these match the app's Zustand stores. For example, a watched entry is `{ movieId, timestamp, tier, rating, watchCount }`, a board is `{ id, name, movieIds, createdAt, updatedAt }`, and a friend is `{ id, name, handle, color, level, watched: [{ movieId, tier }] }`. You can hydrate stores directly from responses.
- **Errors:** `{ error: { message, details? } }`. Validation errors (400) list each bad field in `details`.
- **Idempotency-Key:** any signed-in change (POST, PUT, PATCH, DELETE) can carry an `Idempotency-Key` header: 8–100 characters of `A–Z a–z 0–9 _ -`, unique per change. If the same key arrives again, the server sends back the first response (marked `Idempotent-Replayed: true`) without applying the change a second time. Using the key for a different request returns `409`. Keys are per account and kept for 7 days. The app sends one with every change, so re-sending after a lost reply or a restart is safe.
- **Deletes don't fail when the thing is already gone:** removing a movie that's no longer on the watchlist, watched list or a board, deleting a board that no longer exists, or skipping when there's no active challenge all succeed. The end state is what was asked for.

## Endpoints

### Auth (public)
| Method | Path | Body |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password (8+), displayName, handle? }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | *(signed in)* returns a fresh token |
| POST | `/api/auth/google` | `{ idToken }` from Google Sign-In. Returns `{ token, user, isNew }`. |
| POST | `/api/auth/apple` | `{ identityToken, fullName? }` from Sign in with Apple. Returns `{ token, user, isNew }`. |

**Google and Apple sign-in.** The server checks the token's signature against Google's or Apple's published keys, and checks that it was issued for this app.
- **First sign-in:** links to the account with the same email, but only if the provider verified that email. Otherwise it creates a new account.
- **After that:** the provider's user id finds the account.
- **No password:** these accounts have `user.hasPassword = false`. Email/password login tells them to use the button instead, and deleting the account takes `{ confirm: "DELETE" }` in place of a password.

Setup:
- **Google:** in Google Cloud Console (APIs & Services → Credentials), create OAuth client ids: a **Web** one, plus **iOS** and **Android** ones for the app. The Android one needs the app's package name and signing-key SHA-1. Put the web client id in this server's `GOOGLE_CLIENT_IDS`. Put the web and iOS ids in the app's `.env.local`, as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. Then make a new build of the app.
- **Apple (iPhone only):** needs an Apple Developer membership. `APPLE_CLIENT_IDS` defaults to the app's bundle id. Add `host.exp.Exponent` to test from Expo Go. The capability is set from the app's `app.json`, so make a new build of the app.

Until these are set, the buttons explain what's missing, and the server answers `503`.

### Movies
The pool (public):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/movies` | Pool only. Query: `q` (title, director, cast or year — the app's search uses it), `genres=Drama,Comedy` (matches any), `decade`, `runtime`, `minRating`, `director`, `ids=603,550` (the sign-in screen's poster wall uses it), `sort=rank\|rating\|year\|runtime\|title`, `order`, `page`, `limit` |
| GET | `/api/movies/meta` | genres, decades, runtimes, Taste DNA dimensions and themes |
| GET | `/api/movies/reels` | `{ clips: [{ movieId, youtubeId, start, end }], clipSeconds, movies }`: trailer clips for the Reels feed, with their movies |

Everything on TMDB (signed in, at most 120 requests a minute per account):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/movies/search` | `?q=matrix&page=1&year=`. Any movie, by title. Results are summaries: `{ id, title, year, rating, votes, genres, poster, backdrop, description }`. |
| GET | `/api/movies/lists/:kind` | `trending`, `popular`, `now-playing`, `upcoming`, `top-rated`. `?page`, and `region=GB` (two letters) for what's in cinemas there. |
| GET | `/api/movies/discover` | `?genre=Sci-Fi&decade=1990s&minRating=7&sort=popular\|rating\|newest&page`. Feature films only (40+ minutes). |
| GET | `/api/movies/batch` | `?ids=603,550` (up to 50). Several movies at once; unknown ids are left out. |
| GET | `/api/movies/:id` | Any movie's page: the full movie, including `details.castDetails` (with photos and characters), `directors`, `writers`, `trailer`, `collection`, `rated`. Fetched from TMDB the first time. `inPool` says whether it's in the pool. Also `collections`: the ones it's in (with cards in `movies`). |
| GET | `/api/movies/:id/similar` | TMDB's recommendations for it (or its similar movies, without any). |
| GET | `/api/movies/:id/providers` | `?region=US`. Where to watch it there: `{ stream, free, ads, rent, buy }` (each `[{ id, name, logo }]`), `link`, and `source: "JustWatch"`. |
| GET | `/api/movies/collections/:id` | A TMDB collection ("The Dark Knight Collection"): `{ name, franchise, overview, poster, movies }`, oldest first. |

### People (signed in)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/people/search` | `?q=nolan`. `{ id, name, photo, knownFor, knownForTitles }`. |
| GET | `/api/people/:id` | Biography, birthday, photo, and every movie: `acting` (with `character`), `directing`, `otherCrew` (with `jobs`). Newest first. |

### Me
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | **Everything at once:** profile, settings, library, boards, challenges, taste, recent searches — and `movies` (every movie in them) and `collections` (yours, as in `/me/library`). The app uses it on sign-in, and to refresh everything when it comes back to the front. |
| POST | `/api/me/import` | Uploads the app's local AsyncStorage stores (`{ movieStore, boardStore, profileStore, userStore, tasteStore, challengeStore, languageStore, themeStore, tipsStore, recentSearchStore }`, each optional). Each store you send **replaces** that part of the account. |
| DELETE | `/api/me` | `{ password }`. Deletes the account and all its data. |
| GET / PATCH | `/api/me/profile` | `{ displayName, bio, avatarUri, handle }`. `xp` and `level` are read-only (see below). |
| PUT | `/api/me/top-ten` | `{ movieIds }`, up to 10, #1 first |
| PUT | `/api/me/pinned-collections` | `{ collectionIds }`, up to 3 |
| GET / PATCH | `/api/me/settings` | `{ language, theme, preferences (merged), hasCompletedOnboarding, tipsSeen (merged), resetTips }` |
| GET / POST / DELETE | `/api/me/searches` | POST `{ term }`. Keeps the 8 most recent. |

### Library
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me/library` | the whole library at once: `{ bucketList, watched, pickedMovie, pickMood, unlockedCollections }`, plus `movies` (every movie in it) and `collections` (the ones you've started or unlocked — see Collections) |
| GET / POST | `/api/me/watchlist` | POST `{ movieId }` |
| DELETE | `/api/me/watchlist/:movieId`, `/api/me/watchlist` | remove one, or clear |
| GET / POST | `/api/me/watched` | POST `{ movieId, tier?, watchedAt? }`. This also removes the movie from the watchlist, clears it as the pick, and completes the active challenge if the movie is its target (returned as `completedChallenge`). |
| PATCH | `/api/me/watched/:movieId` | `{ tier (S–F or null), watchedAt }` |
| POST | `/api/me/watched/:movieId/rewatch` | bumps `watchCount` |
| DELETE | `/api/me/watched/:movieId`, `/api/me/watched` | |
| GET / PUT / DELETE | `/api/me/pick` | PUT `{ movieId, mood? }` |
| PUT / DELETE | `/api/me/unlocked-collections/:collectionId` | |
| GET | `/api/me/candidates` | `?genres=Horror,Thriller&decade=1980s&runtime=Any&minRating=7&count=300` (10–500). The movies the app chooses from: the whole pool minus what you've watched (and passed on this week), filtered, ranked by your taste (tiers, passes, leanings — the app's own taste engine), three quarters best-ranked and a quarter at random. If fewer than `count` match, every match comes first, then the closest as the filters loosen. Returns `{ movies, matching (how many match exactly), relaxed (0 = nothing loosened), filters, generatedAt }`. |
| GET | `/api/me/recommendations` | `?count=10&includeWatchlist=true`. Watchlist movies get guaranteed slots, the rest follow your preferences, and watched movies are skipped. (Not used by the app.) |

### Challenges and taste
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me/challenges` | `{ activeChallenge, history }` |
| POST | `/api/me/challenges/active` | `{ challenge }`, the object the app generated (needs `id` and `targetMovieId`) |
| POST | `/api/me/challenges/active/skip` | |
| DELETE | `/api/me/challenges/history` | |
| GET / DELETE | `/api/me/taste` | `{ aspects, passes, leanings }` |
| PUT | `/api/me/taste/leanings` | `{ leanings: [-1\|0\|1 × 6] \| null }` |
| PUT | `/api/me/taste/aspects/:movieId` | `{ aspects: [...] }`. An empty list removes them. |
| POST | `/api/me/taste/passes` | `{ movieId }`. Keeps the newest 300. |

### Boards
| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/boards` | POST `{ id?, name (≤40), movieIds? }`. The app sends its own board `id`; creating an existing one of yours (a retry) returns it. |
| GET / PATCH / DELETE | `/api/boards/:id` | PATCH `{ name }`. Friends can GET; only the owner can change a board. |
| POST | `/api/boards/:id/movies` | `{ movieId }`, appended to the end |
| PUT | `/api/boards/:id/movies` | `{ movieIds }`, replaces the list (for reordering) |
| DELETE | `/api/boards/:id/movies/:movieId` | |

### Friends and activity
| Method | Path | Notes |
|---|---|---|
| GET | `/api/users/search?q=` | by handle or name; each result includes `relationship` |
| GET | `/api/users/:id` | public card. Friends also get `watched`, `topTen`, `boardCount`. |
| GET | `/api/users/:id/boards` | friends only |
| GET | `/api/friends` | your friends, with their tiered watch history |
| GET | `/api/friends/requests` | `{ incoming, outgoing }` |
| POST | `/api/friends/requests` | `{ userId }` or `{ handle }`. If they already asked you, this accepts their request. |
| POST | `/api/friends/requests/:userId/accept` | |
| DELETE | `/api/friends/requests/:userId` | decline or cancel |
| DELETE | `/api/friends/:userId` | unfriend |
| GET | `/api/activity` | friends' feed, newest first. `?before=<timestamp>&limit=30&includeMine=false` |
| GET | `/api/activity/mine` | |
| POST | `/api/activity` | `{ type: "badge", badge }` or `{ type: "set", set, count }` |

`watched`, `tier` and `watchlist` events are recorded automatically. Badges and completed collections are worked out on the device, so the app posts them. Re-tiering the same movie within an hour updates the earlier event instead of adding a new one.

**Cleanup:** the feed keeps the last 90 days and at most each person's newest 200 events. Older ones are deleted when the server starts and every 6 hours after (`pruneActivity` in `src/lib/activity.js`).

### Community
Totals across everyone on ReelBoard, never who tiered what. Signed in.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/community/movies/:movieId` | `{ watchedCount, watchlistCount, tieredCount, tiers: { S, A, B, C, D, F } }`. The movie page's "ReelBoard community" bars. |
| GET | `/api/community/trending` | `?days=7&limit=20`. `trending`: most watched + saved in that window. `favorites`: highest share of S and A tiers, among movies with at least 2 tiers. Discover's top rows. |

### Clubs
A club is a group with a shared board, a "now watching" pick set by the owner, a club tier list (the average of members' tiers on the club's movies) and a feed. Clubs are private:
- **Joining:** by invite code only. Clubs aren't listed or searchable, and anyone who isn't a member gets `404`.
- **What members see:** each other's tiers, but only for the club's movies. The club feed only covers those movies too.
- **Limits:** up to 20 clubs per person, 100 members per club, and 500 movies per board.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/clubs` | GET: your clubs (each with `movieIds`). POST `{ name (≤40), description? (≤200), movieIds? }` creates one; you're its owner. |
| POST | `/api/clubs/join` | `{ code }` (any case). Already a member returns the club. |
| GET / PATCH / DELETE | `/api/clubs/:id` | GET: the club in full (members, `movies` with each member's `watches`, `nowWatching`, `inviteCode`). PATCH (owner) `{ name?, description?, nowWatching? (movie id or null) }`. DELETE (owner) deletes it for everyone. |
| POST | `/api/clubs/:id/leave` | Members only; the owner deletes the club instead. |
| POST | `/api/clubs/:id/invite` | Owner: a new invite code. The old one stops working. |
| DELETE | `/api/clubs/:id/members/:userId` | Owner removes a member. |
| POST | `/api/clubs/:id/movies` | `{ movieId }`. Any member adds to the board. |
| DELETE | `/api/clubs/:id/movies/:movieId` | Whoever added it, or the owner. |
| GET | `/api/clubs/:id/activity` | `?before=<timestamp>&limit=30`. What members did with the club's movies. |

### Movie night on everyone's phones
| Method | Path | Notes |
|---|---|---|
| POST | `/api/movie-nights` | `{ movieIds }`, 4–30 movies. Starts a night with you as host. Returns `{ night }` with its 6-character `code`. |
| POST | `/api/movie-nights/join` | `{ code }`. Joins it (up to 8 people). |
| GET | `/api/movie-nights/:id` | the night as you see it. The app checks every few seconds. |
| PUT | `/api/movie-nights/:id/picks` | `{ kept: [movieId] }`. Your swipes are done. |
| POST | `/api/movie-nights/:id/close` | host only: shows the results now, with whoever has finished. |
| DELETE | `/api/movie-nights/:id/members/me` | leave. When the host leaves, the night ends for everyone. |

- **The rules:** everyone swipes the same stack. Other people's picks stay hidden until everyone (at least two people) is done, or the host closes it. Then `results` lists the `matches` (kept by everyone who finished) and per-movie `counts`.
- **Invites:** the code goes out as a link, `reelboard://night/CODE`, which opens the room in the app. Codes leave out 0/O and 1/I/L so they're easy to read out.
- **Notifications:** the host hears when someone joins, and everyone hears when the results are in (see Push below).
- **Cleanup:** a night lasts 12 hours. Ended ones are deleted with the activity cleanup, every 6 hours.

### Push notifications
| Method | Path | Notes |
|---|---|---|
| POST | `/api/me/push-tokens` | `{ token, platform? }`: this phone's Expo push token. |
| DELETE | `/api/me/push-tokens` | `{ token }`. The app sends this when you sign out or switch notifications off. |

The server sends through Expo's push service (`src/lib/push.js`) for: friend requests, accepted requests, someone joining your movie night, and movie night results. Messages are in the account's language (English or Arabic). Tokens Expo reports as no longer registered are deleted.

**Before server push works,** the app needs an EAS project id: run `eas init` in `../Reelboard` (free Expo account) and make a new build. Until then the app still gets its own reminders, which need no server: tonight's pick at 7:30 pm and the monthly recap on the 1st.

### Collections (signed in)

A franchise, a director's films, an actor's films, the best of a decade or a genre, worked out from the pool (`src/lib/collections.js`). They're sent as definitions, `{ id, type, title, movieIds }`, with ids like `director-christopher-nolan`:
- **franchise, director:** 2+ pool films. **actor:** 3+ in the top-billed cast. **decade, genre:** all of them, trimmed to the 15 best-ranked ("Best of the 1990s").
- **Yours** come with `/me/library` and `/me`: every one you've unlocked, and the ones you've started. For a franchise, decade or genre one film is a start; for a director or an actor it takes two. That always includes every finished collection, and every one a single watch could finish, so the app's XP (and a dare's promised XP) matches the server's.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/collections` | The best-known 30 franchises, directors and actors (by their films' TMDB votes), and every decade and genre, with cards for the first 4 films of each. Sent with an `ETag` (`If-None-Match` → `304`). The app's collection browser and suggestions use it. |
| GET | `/api/collections/:id` | One collection, with cards for every film in it. |

### XP and level

The server works these out from the watch history (`src/lib/xp.js`) and stores them on the account, so the level friends see can't be faked:
- **When it updates:** after every change to a watch history, and for everyone when the server starts.
- **What's ignored:** `xp` and `level` sent to `PATCH /api/me/profile`.
- **Same rules as the app:** they match the app's `src/utils/xp.js` exactly, so its instant display agrees with the server. Change both together.

The rules:
- 100 XP per movie watched
- 50 per genre and 50 per decade
- 75 per director you've seen 3+ films by
- 200 per finished franchise / director / actor collection of 3+ films (the pool's — see Collections)
- 10 per rated movie

### Admin (signed in, `ADMIN_EMAILS` only)
The [admin site](../Reelboard-admin) uses these. Every request checks that the account's email is in `ADMIN_EMAILS`, matched case-insensitively. Other accounts get `403`.

Edits to movies and sagas are live, and they're also written to `data/curation.json` (in its own layout, so the git diff shows just the changed lines). That way `npm run build-pool` keeps them. Each one also recomputes everyone's level.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/me` | the admin's own profile |
| GET | `/api/admin/stats` | accounts (total, new, active), sign-ups per day for 30 days, totals, most watched (30 days) and most S-tiered movies, saga progress |
| GET | `/api/admin/users` | `?q=&page=&limit=`. Search by name, handle or email. |
| GET / DELETE | `/api/admin/users/:id` | an account: profile, counts, tiers, recent activity. DELETE removes it (not your own). |
| GET | `/api/admin/meta` | Taste DNA dimensions and themes, tiers, saga kinds |
| GET | `/api/admin/movies` | `?q=&scope=pool\|other\|all&vibe=any\|hand\|estimated&page=&limit=` |
| GET / PATCH | `/api/admin/movies/:id` | Any TMDB movie (fetched if new), with its stats. PATCH `{ vibe?: { dims: [6 × 1–5], themes: [≤3] }, franchise?: string \| null, inPool?: boolean }`. A vibe becomes hand-tuned. `inPool: false` adds the movie to curation's `excluded`. |
| GET / POST | `/api/admin/sagas` | POST `{ id, title, subtitle?, kind, movieIds (3+), ranks: [{ title, at }] }`. The last rank always needs every film, and films not in the pool join it. |
| GET / PATCH / DELETE | `/api/admin/sagas/:id` | PATCH any of `title`, `subtitle`, `kind`, `movieIds`, `ranks`. New films are saved to curation as `from: { ids }`. |
| GET | `/api/admin/clubs` | `?q=`, by club name or owner handle |
| DELETE | `/api/admin/clubs/:id` | |

The admin site itself is served at `/admin`, from `ADMIN_DIST` (default `../Reelboard-admin/dist`), once it's built.

## The app and this server

The ReelBoard app requires an account and treats this server as the source of truth. It uses TanStack Query to cache the account on the device (see the app's `src/services/queryClient.js`):

- **Reading:** each part of the account is its own query, fetched from its own endpoint (`/me/library`, `/boards`, `/me/profile`, `/me/settings`, `/me/taste`, `/me/challenges`, `/me/searches`). On sign-in, and whenever the app comes back to the front, `GET /api/me` fills all of them in one request.
- **Nothing saved on the phone** but the sign-in session (and the language and theme, which the layout needs before anything loads). Every launch loads the account from the server, with a loading screen and Retry. There's no offline mode.
- **Movies:** there's no catalog on the phone. The app keeps (in memory) every movie a response brought it, and its candidates; asking for a movie it doesn't have fetches it (`/movies/batch`). Search looks through the phone's movies, the pool (`/movies?q=`) and all of TMDB (`/movies/search`) at once.
- **Changing:** a change shows in the app at once and goes to the server straight away, one at a time and in order, each with an `Idempotency-Key` (so a quick retry is safe). When they are done, the parts of the account they touched are refetched. If a change fails (rejected, or the server can't be reached) the app says so and refetches; nothing is kept to send later.

**Running both in development:**

1. Start this server: `npm run dev`. It listens on port 4000.
2. Start the app: `npx expo start` in `../Reelboard`.

The app finds the server on its own: it uses the address of the computer running the Expo dev server, port 4000, so a phone on the same Wi-Fi works. To point it somewhere else, set `EXPO_PUBLIC_API_URL` (e.g. in `../Reelboard/.env`: `EXPO_PUBLIC_API_URL=https://api.example.com/api`). The sign-in screen shows which server it's using.

If a phone can't connect, allow port 4000 through the Windows firewall for Node.

`POST /api/me/import` isn't used by the app any more. It's kept for moving data in from elsewhere.

## Not included yet

- **Avatar upload:** `avatarUri` is stored as given. A local `file://` URI from the image picker won't show for friends until uploads are added.
- **Session token storage:** the token is in AsyncStorage. Switch it to `expo-secure-store` for encrypted storage (this needs a new dev build).
- **HTTPS:** release builds of the app need an HTTPS server URL. Android blocks plain HTTP outside development.
- **No rate limiting on `/api/auth`:** add it (e.g. `express-rate-limit`) before going public. `/api/movie-nights/join` should get the same, so codes can't be guessed.
