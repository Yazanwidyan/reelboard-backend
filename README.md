# ReelBoard Backend

REST API for the [ReelBoard](../Reelboard) app. It handles accounts, the movie catalog, your library (watchlist, watched + tiers, tonight's pick), boards, challenges, taste signals, settings, friends and the activity feed.

It's built with Node.js, Express 5 and SQLite (Node's built-in `node:sqlite`, so there's no database server to install), plus JWT auth and zod validation.

## Getting started

```bash
npm install
cp .env.example .env      # then set JWT_SECRET
npm run dev               # http://localhost:4000/api, restarts on changes
npm test                  # end-to-end tests against an in-memory database
```

The database file is created at `data/reelboard.db` on first start. The movie catalog in `data/catalog.json` is loaded into it on every start.

### The movie catalog

`data/catalog.json` is the one place movies are maintained. The app ships no movie data: it loads the whole catalog from `GET /api/movies/catalog` at sign-in. The file holds:

- **`movies`:** each with `id`, `rank`, `title`, `year`, `rating`, `runtime`, `genres`, `director`, `cast`, `details`, `description`, `franchise`, `poster`, `backdrop`, and a `vibe` (`{ dims: [6 × 1–5], themes }`, the Taste DNA values).
- **`reelClips`:** the YouTube trailer windows for Reels.
- **`dimensions` and `themes`:** the Taste DNA vocabulary.

To change it, edit the file and restart the server. Keep movie ids stable, because accounts refer to them.

To refresh cast, details (critic scores, awards, box office…) and IMDb ratings from [OMDb](https://www.omdbapi.com), put `OMDB_API_KEY` in `.env`, then:

```bash
npm run enrich-omdb       # updates data/catalog.json; restart the server after
```

**Adding movies.** The first 250 movies were tagged by hand. The rest come from `data/seed-movies.txt`, one per line as `Title|Year|Franchise|imdbId`. Franchise and IMDb id are optional; an IMDb id pins the exact film when a title is ambiguous (remakes, common titles). Then:

```bash
npm run add-movies                # looks new seeds up on OMDb, adds them to data/catalog.json
npm run add-movies -- --limit 50  # at most 50 lookups this run
npm run add-movies -- --offline   # only uses data/omdb-cache.json, no requests
```

- **Quota:** OMDb's free key allows 1,000 requests a day. Answers are cached in `data/omdb-cache.json` (not committed), so when the quota runs out, run it again the next day and it carries on where it stopped.
- **What gets skipped:** a lookup whose title or year doesn't match the seed, and anything without a poster or rating, under 40 minutes, or a documentary. Movies added earlier that no longer match their seed are removed again.
- **Vibes:** added movies get an estimated Taste DNA vibe, learned from the 250 hand-tagged ones (`vibeSource: "estimated"`, against `"hand"`). Hand-tag the ones that matter most to make them exact.
- **Rank:** added movies are ranked after the first 250 by IMDb's weighted rating, so a 9.0 with 40 votes doesn't outrank a 8.5 with a million.

Restart the server after adding movies. The app picks up the new catalog on its next start (its `ETag` changes).

## Conventions

- **Auth:** send `Authorization: Bearer <token>`. `register` and `login` return `{ token, user }`.
- **Timestamps:** milliseconds since the epoch, the same as `Date.now()` in the app.
- **Movie ids:** the catalog's ids (`m1`, `m2`, …). They never change or get reused, because accounts refer to them. Each movie's IMDb id is in `details.imdbId`.
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

### Movies (public)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/movies` | Query: `q`, `genres=Drama,Comedy` (matches any), `decade`, `runtime`, `minRating`, `director`, `ids=m1,m2`, `sort=rank\|rating\|year\|runtime\|title`, `order`, `page`, `limit` |
| GET | `/api/movies/catalog` | the whole catalog in one response: every movie, the Reels clips, and the Taste DNA vocabulary. Sent with an `ETag`. Send it back as `If-None-Match` and, while the catalog is unchanged, the answer is an empty `304`. |
| GET | `/api/movies/meta` | genres, decades, runtimes, Taste DNA dimensions and themes |
| GET | `/api/movies/reels` | trailer clips for the Reels feed |
| GET | `/api/movies/:id` | one movie |

### Me
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | **Everything at once:** profile, settings, library, boards, challenges, taste, recent searches. The app uses it on sign-in, and to refresh everything when it comes back to the front. |
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
| GET | `/api/me/library` | the whole library at once: `{ bucketList, watched, pickedMovie, pickMood, unlockedCollections }` |
| GET / POST | `/api/me/watchlist` | POST `{ movieId }` |
| DELETE | `/api/me/watchlist/:movieId`, `/api/me/watchlist` | remove one, or clear |
| GET / POST | `/api/me/watched` | POST `{ movieId, tier?, watchedAt? }`. This also removes the movie from the watchlist, clears it as the pick, and completes the active challenge if the movie is its target (returned as `completedChallenge`). |
| PATCH | `/api/me/watched/:movieId` | `{ tier (S–F or null), watchedAt }` |
| POST | `/api/me/watched/:movieId/rewatch` | bumps `watchCount` |
| DELETE | `/api/me/watched/:movieId`, `/api/me/watched` | |
| GET / PUT / DELETE | `/api/me/pick` | PUT `{ movieId, mood? }` |
| PUT / DELETE | `/api/me/unlocked-collections/:collectionId` | |
| GET | `/api/me/recommendations` | `?count=10&includeWatchlist=true`. Watchlist movies get guaranteed slots, the rest follow your preferences, and watched movies are skipped. |

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

### XP and level

The server works these out from the watch history (`src/lib/xp.js`) and stores them on the account, so the level friends see can't be faked:
- **When it updates:** after every change to a watch history, and for everyone when the server starts.
- **What's ignored:** `xp` and `level` sent to `PATCH /api/me/profile`.
- **Same rules as the app:** they match the app's `src/utils/xp.js` exactly, so its instant display agrees with the server. Change both together.

The rules:
- 100 XP per movie watched
- 50 per genre and 50 per decade
- 75 per director you've seen 3+ films by
- 200 per finished franchise / director / actor collection of 3+ films
- 10 per rated movie

## The app and this server

The ReelBoard app requires an account and treats this server as the source of truth. It uses TanStack Query to cache the account on the device (see the app's `src/services/queryClient.js`):

- **Reading:** each part of the account is its own query, fetched from its own endpoint (`/me/library`, `/boards`, `/me/profile`, `/me/settings`, `/me/taste`, `/me/challenges`, `/me/searches`). On sign-in, and whenever the app comes back to the front, `GET /api/me` fills all of them in one request.
- **Saved on the phone:** the cache is saved on the device, so the app opens straight onto the last data it had, even offline. The catalog is saved separately and checked with its `ETag`, so it's only downloaded when it changes.
- **Changing:** a change shows in the app at once and is queued as an API call with an `Idempotency-Key`. Queued calls go out one at a time, in order. Offline they wait, saved on the device so a restart doesn't lose them, and go out once the server can be reached. When the queue is empty, the parts of the account it touched are refetched. If the server rejects a change, the app says so and the refetch undoes it.

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
- **Where to watch:** needs a TMDB API key (free). OMDb doesn't have streaming availability.
