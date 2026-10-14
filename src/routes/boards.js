import { Router } from "express";
import { z } from "zod";
import { get, run, transaction } from "../db/index.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { listBoards, toBoard } from "../lib/library.js";
import { assertMovie } from "../lib/movies.js";
import { BOARD_NAME_MAX, boardId, movieId, uniqueIds } from "../lib/schemas.js";
import { areFriends } from "../lib/users.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/boards — the app's boardStore. A board is a name and an
// ordered list of movie ids (newest last). Friends can view your boards;
// only you can change them.
const router = Router();

const name = z.string().trim().min(1).max(BOARD_NAME_MAX);
const idParam = z.object({ id: z.string().min(1) });

const loadBoard = (boardId, userId, { write = false } = {}) => {
  const board = get("SELECT * FROM boards WHERE id = ?", [boardId]);
  if (!board) throw notFound("No such board");
  if (board.user_id !== userId) {
    // Don't confirm the board exists to strangers.
    if (!areFriends(board.user_id, userId)) throw notFound("No such board");
    if (write) throw forbidden("Only the owner can change a board");
  }
  return board;
};

const touch = (boardId) => run("UPDATE boards SET updated_at = ? WHERE id = ?", [Date.now(), boardId]);

const setMovies = (boardId, movieIds) => {
  run("DELETE FROM board_movies WHERE board_id = ?", [boardId]);
  movieIds.forEach((id, position) => {
    run("INSERT INTO board_movies (board_id, movie_id, position) VALUES (?, ?, ?)", [
      boardId,
      id,
      position,
    ]);
  });
};

router.get("/", (req, res) => {
  res.json({ boards: listBoards(req.userId) });
});

// `id` is optional: the app sends its own board id so later edits can use
// it. Creating a board that already exists (a retried request) returns it.
router.post(
  "/",
  validate(z.object({ id: boardId.optional(), name, movieIds: uniqueIds(movieId, 1000).default([]) })),
  (req, res) => {
    req.body.movieIds.forEach(assertMovie);
    const id = req.body.id ?? newId("b");
    const existing = get("SELECT * FROM boards WHERE id = ?", [id]);
    if (existing) {
      if (existing.user_id !== req.userId) throw conflict("Board id already in use");
      return res.json({ board: toBoard(existing) });
    }
    const now = Date.now();
    transaction(() => {
      run("INSERT INTO boards (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
        id,
        req.userId,
        req.body.name,
        now,
        now,
      ]);
      setMovies(id, req.body.movieIds);
    });
    res.status(201).json({ board: toBoard(get("SELECT * FROM boards WHERE id = ?", [id])) });
  },
);

router.get("/:id", validate(idParam, "params"), (req, res) => {
  res.json({ board: toBoard(loadBoard(req.params.id, req.userId)) });
});

router.patch("/:id", validate(idParam, "params"), validate(z.object({ name })), (req, res) => {
  loadBoard(req.params.id, req.userId, { write: true });
  run("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?", [
    req.body.name,
    Date.now(),
    req.params.id,
  ]);
  res.json({ board: toBoard(get("SELECT * FROM boards WHERE id = ?", [req.params.id])) });
});

router.delete("/:id", validate(idParam, "params"), (req, res) => {
  loadBoard(req.params.id, req.userId, { write: true });
  run("DELETE FROM boards WHERE id = ?", [req.params.id]);
  res.status(204).end();
});

// Replace the whole list — for reordering.
router.put(
  "/:id/movies",
  validate(idParam, "params"),
  validate(z.object({ movieIds: uniqueIds(movieId, 1000) })),
  (req, res) => {
    loadBoard(req.params.id, req.userId, { write: true });
    req.body.movieIds.forEach(assertMovie);
    transaction(() => {
      setMovies(req.params.id, req.body.movieIds);
      touch(req.params.id);
    });
    res.json({ board: toBoard(get("SELECT * FROM boards WHERE id = ?", [req.params.id])) });
  },
);

// Add one movie to the end (no-op if it's already there).
router.post(
  "/:id/movies",
  validate(idParam, "params"),
  validate(z.object({ movieId })),
  (req, res) => {
    loadBoard(req.params.id, req.userId, { write: true });
    assertMovie(req.body.movieId);
    transaction(() => {
      const { changes } = run(
        `INSERT OR IGNORE INTO board_movies (board_id, movie_id, position)
         VALUES (:board, :movie,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM board_movies WHERE board_id = :board))`,
        { board: req.params.id, movie: req.body.movieId },
      );
      if (changes) touch(req.params.id);
    });
    res.json({ board: toBoard(get("SELECT * FROM boards WHERE id = ?", [req.params.id])) });
  },
);

router.delete(
  "/:id/movies/:movieId",
  validate(z.object({ id: z.string().min(1), movieId }), "params"),
  (req, res) => {
    loadBoard(req.params.id, req.userId, { write: true });
    const { changes } = run("DELETE FROM board_movies WHERE board_id = ? AND movie_id = ?", [
      req.params.id,
      req.params.movieId,
    ]);
    if (!changes) throw notFound("That movie isn't on this board");
    touch(req.params.id);
    res.json({ board: toBoard(get("SELECT * FROM boards WHERE id = ?", [req.params.id])) });
  },
);

export default router;
