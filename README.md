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

## Conventions

- **Auth:** send `Authorization: Bearer <token>`. `register` and `login` return `{ token, user }`.
- **Timestamps:** milliseconds since the epoch, the same as `Date.now()` in the app.
- **Movie ids:** the app's ids (`m1` … `m250`).
- **Response shapes:** these match the app's Zustand stores. For example, a watched entry is `{ movieId, timestamp, tier, rating, watchCount }`, a board is `{ id, name, movieIds, createdAt, updatedAt }`, and a friend is `{ id, name, handle, color, level, watched: [{ movieId, tier }] }`. You can hydrate stores directly from responses.
- **Errors:** `{ error: { message, details? } }`. Validation errors (400) list each bad field in `details`.

## Endpoints

### Auth (public)
| Method | Path | Body |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password (8+), displayName, handle? }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | *(signed in)* returns a fresh token |

### Movies (public)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/movies` | Query: `q`, `genres=Drama,Comedy` (matches any), `decade`, `runtime`, `minRating`, `director`, `ids=m1,m2`, `sort=rank\|rating\|year\|runtime\|title`, `order`, `page`, `limit` |
| GET | `/api/movies/catalog` | the whole catalog in one response: every movie, the Reels clips, and the Taste DNA vocabulary. The app loads this at sign-in. |
| GET | `/api/movies/meta` | genres, decades, runtimes, Taste DNA dimensions and themes |
| GET | `/api/movies/reels` | trailer clips for the Reels feed |
| GET | `/api/movies/:id` | one movie |

### Me
| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | **Everything at once:** profile, settings, library, boards, challenges, taste, recent searches. Use it to hydrate the app on sign-in. |
| POST | `/api/me/import` | Uploads the app's local AsyncStorage stores (`{ movieStore, boardStore, profileStore, userStore, tasteStore, challengeStore, languageStore, themeStore, tipsStore, recentSearchStore }`, each optional). Each store you send **replaces** that part of the account. |
| DELETE | `/api/me` | `{ password }`. Deletes the account and all its data. |
| GET / PATCH | `/api/me/profile` | `{ displayName, bio, avatarUri, handle, xp, level }` |
| PUT | `/api/me/top-ten` | `{ movieIds }`, up to 10, #1 first |
| PUT | `/api/me/pinned-collections` | `{ collectionIds }`, up to 3 |
| GET / PATCH | `/api/me/settings` | `{ language, theme, preferences (merged), hasCompletedOnboarding, tipsSeen (merged), resetTips }` |
| GET / POST / DELETE | `/api/me/searches` | POST `{ term }`. Keeps the 8 most recent. |

### Library
| Method | Path | Notes |
|---|---|---|
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

## The app and this server

The ReelBoard app requires an account and treats this server as the source of truth. Its stores hold the signed-in account in memory only. On launch or sign-in it loads `GET /api/me` and the movie catalog (`GET /api/movies/catalog`), and every change is sent to the API as it happens (see the app's `src/services/sync.js`). If a change is rejected or the server can't be reached, the app reloads from the server. The phone keeps only the session token, plus language and theme so the sign-in screen looks right.

**Running both in development:**

1. Start this server: `npm run dev`. It listens on port 4000.
2. Start the app: `npx expo start` in `../Reelboard`.

The app finds the server on its own: it uses the address of the computer running the Expo dev server, port 4000, so a phone on the same Wi-Fi works. To point it somewhere else, set `EXPO_PUBLIC_API_URL` (e.g. in `../Reelboard/.env`: `EXPO_PUBLIC_API_URL=https://api.example.com/api`). The sign-in screen shows which server it's using.

If a phone can't connect, allow port 4000 through the Windows firewall for Node.

`POST /api/me/import` isn't used by the app any more. It's kept for moving data in from elsewhere.

## Not included yet

- **Avatar upload:** `avatarUri` is stored as given. A local `file://` URI from the image picker won't show for friends until uploads are added.
- **XP and level are reported by the app:** the server doesn't recompute them.
- **Session token storage:** the token is in AsyncStorage. Switch it to `expo-secure-store` for encrypted storage (this needs a new dev build).
- **HTTPS:** release builds of the app need an HTTPS server URL. Android blocks plain HTTP outside development.
- **No rate limiting on `/api/auth`:** add it (e.g. `express-rate-limit`) before going public.
