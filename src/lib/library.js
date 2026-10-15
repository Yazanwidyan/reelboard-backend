import { all, fromJSON, get, run } from "../db/index.js";
import { moviesOutsidePool } from "./movies.js";
import { toProfile, getUserRow } from "./users.js";

// Serializers and reads for a user's own data, in the same shapes the app's
// Zustand stores persist — so a store can be hydrated straight from these.

// movieStore.bucketList entry: { movieId, addedAt }
export const listWatchlist = (userId) =>
  all(
    "SELECT movie_id, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at",
    [userId],
  ).map((row) => ({ movieId: row.movie_id, addedAt: row.added_at }));

// movieStore.watched entry: { movieId, timestamp, tier, rating, watchCount }
export const toWatchedEntry = (row) => ({
  movieId: row.movie_id,
  timestamp: row.watched_at,
  tier: row.tier,
  rating: row.rating,
  watchCount: row.watch_count,
});

export const listWatched = (userId) =>
  all("SELECT * FROM watched WHERE user_id = ? ORDER BY watched_at DESC", [userId]).map(
    toWatchedEntry,
  );

export const getWatchedEntry = (userId, movieId) => {
  const row = get("SELECT * FROM watched WHERE user_id = ? AND movie_id = ?", [userId, movieId]);
  return row ? toWatchedEntry(row) : null;
};

export const getUserState = (userId) =>
  get("SELECT * FROM user_state WHERE user_id = ?", [userId]);

export const toSettings = (state) => ({
  language: state.language,
  theme: state.theme,
  preferences: fromJSON(state.preferences, {}),
  hasCompletedOnboarding: Boolean(state.has_completed_onboarding),
  tipsSeen: fromJSON(state.tips_seen, {}),
});

export const toPick = (state) => ({
  pickedMovie: state.picked_movie_id,
  pickMood: state.picked_movie_id && state.pick_mood
    ? { movieId: state.picked_movie_id, mood: state.pick_mood }
    : null,
});

// boardStore board: { id, name, movieIds, createdAt, updatedAt }
export const toBoard = (row) => ({
  id: row.id,
  name: row.name,
  movieIds: all(
    "SELECT movie_id FROM board_movies WHERE board_id = ? ORDER BY position",
    [row.id],
  ).map((movie) => movie.movie_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.user_id ? { ownerId: row.user_id } : {}),
});

export const listBoards = (userId) =>
  all("SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC", [userId]).map(toBoard);

// challengeStore: { activeChallenge, history: [{ ...challenge, status, resolvedAt }] }
const toChallenge = (row) => ({
  ...fromJSON(row.data, {}),
  ...(row.status === "active" ? {} : { status: row.status, resolvedAt: row.resolved_at }),
});

export const getChallenges = (userId) => {
  const rows = all(
    "SELECT * FROM challenges WHERE user_id = ? ORDER BY COALESCE(resolved_at, accepted_at) DESC",
    [userId],
  );
  const active = rows.find((row) => row.status === "active");
  return {
    activeChallenge: active ? toChallenge(active) : null,
    history: rows.filter((row) => row.status !== "active").map(toChallenge),
  };
};

// Called whenever a movie is marked watched: completes the active challenge
// if this movie is its target. Returns the completed challenge, or null.
export const completeChallengeFor = (userId, movieId) => {
  const active = get(
    "SELECT * FROM challenges WHERE user_id = ? AND status = 'active' AND target_movie_id = ?",
    [userId, movieId],
  );
  if (!active) return null;
  const resolvedAt = Date.now();
  run("UPDATE challenges SET status = 'completed', resolved_at = ? WHERE id = ?", [
    resolvedAt,
    active.id,
  ]);
  return toChallenge({ ...active, status: "completed", resolved_at: resolvedAt });
};

// tasteStore: { aspects: { [movieId]: string[] }, passes: [{ movieId, at }], leanings }
export const getTaste = (userId) => ({
  aspects: Object.fromEntries(
    all("SELECT movie_id, aspects FROM taste_aspects WHERE user_id = ?", [userId]).map((row) => [
      row.movie_id,
      fromJSON(row.aspects, []),
    ]),
  ),
  passes: all("SELECT movie_id, at FROM taste_passes WHERE user_id = ? ORDER BY at DESC", [
    userId,
  ]).map((row) => ({ movieId: row.movie_id, at: row.at })),
  leanings: fromJSON(getUserState(userId).leanings),
});

// The library part of the state (GET /api/me/library).
export const getLibrary = (userId, state = getUserState(userId)) => ({
  bucketList: listWatchlist(userId),
  watched: listWatched(userId),
  ...toPick(state),
  unlockedCollections: fromJSON(state.unlocked_collections, []),
});

export const libraryMovieIds = (library) => [
  ...library.bucketList.map((entry) => entry.movieId),
  ...library.watched.map((entry) => entry.movieId),
  library.pickedMovie,
];

// Everything the app keeps locally, in one response — what the app loads
// on sign-in to hydrate its stores. `movies`: the ones in it that aren't in
// the pool (found with search, say), so the app can show them.
export const getFullState = (userId) => {
  const state = getUserState(userId);
  const profile = toProfile(getUserRow(userId));
  const library = getLibrary(userId, state);
  const boards = listBoards(userId);
  const challenges = getChallenges(userId);
  const taste = getTaste(userId);
  return {
    profile,
    settings: toSettings(state),
    library,
    boards,
    challenges,
    taste,
    recentSearches: fromJSON(state.recent_searches, []),
    movies: moviesOutsidePool([
      ...libraryMovieIds(library),
      ...boards.flatMap((board) => board.movieIds),
      ...profile.topTen,
      ...[challenges.activeChallenge, ...challenges.history]
        .filter(Boolean)
        .map((challenge) => challenge.targetMovieId),
      ...Object.keys(taste.aspects),
      ...taste.passes.map((pass) => pass.movieId),
    ]),
  };
};
