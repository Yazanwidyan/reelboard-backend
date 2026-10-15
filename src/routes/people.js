import { Router } from "express";
import { z } from "zod";
import { notFound } from "../lib/errors.js";
import { imageUrl, tmdbGet } from "../lib/tmdb.js";
import { toPersonSummary, toSummary } from "../lib/tmdbMovies.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";

// Mounted at /api/people (signed in) — actors and directors from TMDB.
const router = Router();

const DAY = 24 * 60 * 60 * 1000;
router.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// GET /api/people/search?q=nolan — people by name, most known first.
router.get(
  "/search",
  validate(
    z.object({
      q: z.string().trim().min(1).max(100),
      page: z.coerce.number().int().min(1).max(500).default(1),
    }),
    "query",
  ),
  async (req, res) => {
    const { q, page } = req.validQuery;
    const data = await tmdbGet(
      "/search/person",
      { query: q, page, include_adult: "false", language: "en-US" },
      { ttl: 10 * 60 * 1000 },
    );
    res.json({
      results: (data?.results ?? []).filter((person) => !person.adult).map(toPersonSummary),
      page,
      totalPages: Math.min(data?.total_pages ?? 0, 500),
    });
  },
);

// Newest first; unreleased (no date yet) at the top.
const byNewest = (a, b) => (b.releaseDate || "9999").localeCompare(a.releaseDate || "9999");

// GET /api/people/:id — who they are, and every movie they've acted in or
// made (directing, writing, producing…), newest first.
router.get(
  "/:id",
  validate(z.object({ id: z.string().regex(/^\d{1,10}$/) }), "params"),
  async (req, res) => {
    const data = await tmdbGet(
      `/person/${req.params.id}`,
      { append_to_response: "movie_credits", language: "en-US" },
      { ttl: DAY },
    );
    if (!data) throw notFound("No such person");
    const credits = data.movie_credits ?? {};
    const withDate = (credit) => ({ ...toSummary(credit), releaseDate: credit.release_date || null });

    // One entry per movie, with every role they had in it.
    const cast = new Map();
    (credits.cast ?? [])
      .filter((credit) => !credit.adult)
      .forEach((credit) => {
        if (!cast.has(credit.id)) cast.set(credit.id, { ...withDate(credit), character: credit.character || null });
      });
    const crew = new Map();
    (credits.crew ?? [])
      .filter((credit) => !credit.adult)
      .forEach((credit) => {
        const entry = crew.get(credit.id) ?? { ...withDate(credit), jobs: [] };
        if (!entry.jobs.includes(credit.job)) entry.jobs.push(credit.job);
        crew.set(credit.id, entry);
      });

    res.json({
      person: {
        id: String(data.id),
        name: data.name,
        biography: data.biography || "",
        birthday: data.birthday || null,
        deathday: data.deathday || null,
        placeOfBirth: data.place_of_birth || null,
        photo: imageUrl(data.profile_path, "w342"),
        knownFor: data.known_for_department ?? null,
        acting: [...cast.values()].sort(byNewest),
        directing: [...crew.values()].filter((entry) => entry.jobs.includes("Director")).sort(byNewest),
        otherCrew: [...crew.values()].filter((entry) => !entry.jobs.includes("Director")).sort(byNewest),
      },
    });
  },
);

export default router;
