import { IMAGE_BASE, tmdbGet } from "./tmdb.js";

// Where a saga's films come from — its `from` in data/curation.json — turned
// into TMDB movie ids. Shared by `npm run build-pool` (which caches TMDB's
// answers in data/tmdb-cache.json) and the admin site (which previews a
// rule before saving it), so both resolve a rule to the same films.
//
//   { ids: [...] }                 films picked one by one
//   { tmdbCollections: [id, …] }   TMDB collections, together
//   { movies: ["Title|Year", …] }  a hand-made list (build-pool only)
//   { company: id, minVotes }      a studio's films
//   { director: name, minVotes, top }   a director's films
//   { actor: name, minVotes, top }      an actor's lead roles
//
// Released films only, oldest first.

const DOCUMENTARY = 99;
// An actor's saga: lead roles only (billed in the top three) in films
// people know.
const LEAD_ORDER = 2;
export const ACTOR_MIN_VOTES = 1500;
export const DIRECTOR_MIN_VOTES = 500;
export const COMPANY_MIN_VOTES = 300;
const MIN_RUNTIME = 40;
const COMPANY_PAGES = 5;

// `cached(key, fetch)`: how answers are kept (build-pool's file cache; the
// server's TMDB client caches by itself). `findByTitle(title, year)`: for
// hand-made lists. `today`: "YYYY-MM-DD", for what counts as released.
export const createSagaResolver = ({
  cached = (key, fetch) => fetch(),
  findByTitle = null,
  today = new Date().toISOString().slice(0, 10),
} = {}) => {
  const released = (date) => Boolean(date) && date <= today;

  const tmdbCollection = (id) =>
    cached(`collection:${id}`, async () => {
      const data = await tmdbGet(`/collection/${id}`, { language: "en-US" });
      return (
        data && {
          name: data.name,
          backdrop: data.backdrop_path ?? null,
          parts: (data.parts ?? []).map(({ id: part, release_date, adult }) => ({ id: part, release_date, adult })),
        }
      );
    });

  const findPerson = (name) =>
    cached(`person:${name.toLowerCase()}`, async () => {
      const data = await tmdbGet("/search/person", { query: name, include_adult: "false" });
      const person = (data?.results ?? []).find((result) => result.name.toLowerCase() === name.toLowerCase());
      return person ? { id: person.id, name: person.name, photo: person.profile_path ?? null } : null;
    });

  const credits = (personId) =>
    cached(`credits:${personId}`, async () => {
      const data = await tmdbGet(`/person/${personId}/movie_credits`, { language: "en-US" });
      const slim = ({ id, order, job, character, vote_count, release_date, genre_ids, adult }) => ({
        id, order, job, character, vote_count, release_date, genre_ids, adult,
      });
      return data && { cast: (data.cast ?? []).map(slim), crew: (data.crew ?? []).map(slim) };
    });

  const companyFilms = (companyId, minVotes) =>
    cached(`company:${companyId}:${minVotes}`, async () => {
      const ids = [];
      for (let page = 1; page <= COMPANY_PAGES; page += 1) {
        const data = await tmdbGet("/discover/movie", {
          with_companies: companyId,
          "vote_count.gte": minVotes,
          "with_runtime.gte": MIN_RUNTIME,
          sort_by: "primary_release_date.asc",
          include_adult: "false",
          page,
        });
        ids.push(...(data?.results ?? []).filter((movie) => released(movie.release_date)).map((movie) => movie.id));
        if (page >= (data?.total_pages ?? 0)) break;
      }
      return ids;
    });

  // A person's films for a saga: the credits that count — the best-known
  // `top` of them — oldest first.
  const pickCredits = (list, { minVotes, top }) =>
    list
      .filter(
        (credit) =>
          !credit.adult &&
          released(credit.release_date) &&
          (credit.vote_count ?? 0) >= minVotes &&
          !(credit.genre_ids ?? []).includes(DOCUMENTARY),
      )
      .filter((credit, i, all) => all.findIndex((other) => other.id === credit.id) === i)
      .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
      .slice(0, top ?? Infinity)
      // Then oldest first, like every saga.
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .map((credit) => credit.id);

  // → { ids, art, person, source } — `source` says what it resolved to.
  const resolveSaga = async ({ from, person: curatedPerson }) => {
    // Films picked one by one (the admin site saves a saga's films this way).
    if (from.ids) {
      return { ids: from.ids.map(Number), art: null, person: curatedPerson ?? null, source: `${from.ids.length} picked` };
    }
    if (from.tmdbCollections) {
      const found = await Promise.all(from.tmdbCollections.map(tmdbCollection));
      const parts = found
        .filter(Boolean)
        .flatMap((collection) => collection.parts)
        .filter((part) => !part.adult && released(part.release_date))
        .sort((a, b) => a.release_date.localeCompare(b.release_date));
      const backdrop = found.find((collection) => collection?.backdrop)?.backdrop;
      return {
        ids: parts.map((part) => part.id),
        art: backdrop ? { backdrop: `${IMAGE_BASE}/w1280${backdrop}` } : null,
        source: found.map((collection) => collection?.name ?? "?").join(" + "),
      };
    }
    if (from.movies) {
      if (!findByTitle) return { ids: [], art: null, source: "a hand-made list (resolved by build-pool)" };
      const ids = [];
      const missing = [];
      for (const line of from.movies) {
        const [title, year] = line.split("|");
        const id = await findByTitle(title, Number(year));
        if (id) ids.push(id);
        else missing.push(line);
      }
      return { ids, art: null, source: `${ids.length} listed${missing.length ? `, not found: ${missing.join(", ")}` : ""}` };
    }
    if (from.company) {
      return {
        ids: (await companyFilms(from.company, from.minVotes ?? COMPANY_MIN_VOTES)) ?? [],
        art: null,
        source: `company ${from.company}`,
      };
    }
    const name = from.director ?? from.actor;
    if (name) {
      const person = await findPerson(name);
      const list = person ? await credits(person.id) : null;
      if (!list) return { ids: [], art: null, source: `${name}: not found` };
      const ids = from.director
        ? pickCredits(list.crew.filter((credit) => credit.job === "Director"), {
            minVotes: from.minVotes ?? DIRECTOR_MIN_VOTES,
            top: from.top,
          })
        : pickCredits(
            list.cast.filter(
              (credit) => (credit.order ?? 99) <= LEAD_ORDER && !/\bhimself\b|\bherself\b|uncredited/i.test(credit.character ?? ""),
            ),
            { minVotes: from.minVotes ?? ACTOR_MIN_VOTES, top: from.top },
          );
      return {
        ids,
        art: person.photo ? { photo: `${IMAGE_BASE}/h632${person.photo}` } : null,
        // Who it's about, so their name on a movie page opens it.
        person: person.name,
        source: person.name,
      };
    }
    return { ids: [], art: null, source: "no `from`" };
  };

  return { resolveSaga };
};

// Rank thresholds as film counts: `at` a count (or "all"), `share` a part of
// the whole. Rising, one per count — a smaller saga keeps its higher ranks.
export const resolveRanks = (ranks, total) => {
  const counts = ranks.map((rank) => ({
    title: rank.title,
    at:
      rank.at === "all"
        ? total
        : rank.share != null
          ? Math.max(1, Math.ceil(rank.share * total))
          : Math.min(rank.at, total),
  }));
  return counts.filter(
    (rank, i) => counts.slice(i + 1).every((later) => later.at > rank.at) && (i === 0 || rank.at > 0),
  );
};
