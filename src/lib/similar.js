import { getKeywords, keywordWeight } from "./keywords.js";
import { ensureMovies, getAllMovies } from "./movies.js";
import { tmdbGet } from "./tmdb.js";

// "More like this": the films most like a movie, best first, each with how
// similar it is and why. Built on two things that know what a film is
// actually about:
//
//   fans     TMDB's recommendations for it — what people who liked it went
//            on to like. They count fully only when the films also share
//            what they're about (topics or story): TMDB's list wanders.
//   topics   TMDB keywords both films carry ("car race", "le mans",
//            "rivalry") — a rare shared one counts more than a common one.
//
// and, smaller, what supports them:
//
//   feel     Taste DNA closeness (hand-tagged vibes count more than
//            estimated ones)
//   genres   shared genres — broad ones (Drama, Action…) count half
//   story    the rarer words both descriptions use
//   cast     actors in both
//   era      made around the same time
//   rating   how good it is (counted by votes), so weak films don't slip in
//
// Candidates: TMDB's recommendations, well-known films with its rarest
// keywords, and the pool films that look closest on the supporting
// signals. Films by the same director are left out unless asked for — the
// movie page has its own "Also by" row for those. Without TMDB it still
// answers, from the pool and the signals it has.

const WEIGHTS = { fans: 3, topics: 3.5, feel: 1.2, genres: 1, story: 0.8, cast: 0.8, era: 0.4, rating: 1.5 };
// A signal this strong makes it one of the card's reasons.
const REASON_AT = { fans: 0.45, topics: 0.35, feel: 0.85, genres: 0.66, story: 0.4, cast: 0.5, era: 0.85 };
const BROAD_GENRES = new Set(["Drama", "Action", "Comedy", "Thriller", "Adventure"]);
// How many pool films join TMDB's recommendations as candidates, and how
// many of TMDB's are taken.
const POOL_CANDIDATES = 30;
const FANS_MAX = 20;
// Its rarest keywords searched for, and how many films that brings.
const TOPIC_KEYWORDS = 3;
const TOPIC_CANDIDATES = 20;
// How much of "fans" counts with nothing else shared (the rest comes with
// shared topics or story).
const FANS_ALONE = 0.5;
// A topics / story score this high is already a full match: topics is the
// share of a film's most telling keywords (TOPIC_TOP of them) the other
// one has too.
const TOPICS_FULL = 0.5;
const TOPIC_TOP = 8;
// TMDB's tone tags ("intense", "bittersweet"…) say how a film feels, not
// what it's about: they count for less, and aren't searched by.
const TONE_WEIGHT = 0.4;
const TONES = new Set(
  `intense complex mind-blowing serious tragic angry incredulous intellectual philosophical inspirational
  depressing bittersweet suspenseful exhilarated admiring amused dramatic hopeful cheerful playful witty romantic
  sentimental thoughtful awestruck aggressive celebratory defiant grim excited vibrant provocative comforting
  antagonistic approving assertive audacious adoring harsh horrified melancholy sincere straightforward tense
  whimsical absurd cautionary compassionate curious frightened hilarious joyful lighthearted mysterious pensive
  powerful reflective sarcastic shocking sympathetic urgent kind familiar empathetic factual disheartening
  dignified demanding enthusiastic informative instructive loving mean-spirited`.split(/\s+/),
);
// A keyword sharing a word (5+ letters) with one of the other film's —
// "dream" and "dream world" — counts this much of a full match.
const WORD_MATCH = 0.5;
const STORY_FULL = 0.3;
// An estimated vibe is a guess: its feel score is pulled towards neutral.
const ESTIMATED_FEEL = 0.6;
const MAX_DISTANCE = Math.sqrt(6 * 4 * 4); // six 1–5 dims
const ERA_SPAN = 25;
const NEUTRAL_DIMS = [3, 3, 3, 3, 3, 3];
const DAY = 24 * 60 * 60 * 1000;

// A rating counted by how many people gave it (IMDb's Top 250 formula, as
// in the app's utils/movieFilters), so a 9 from a few fans isn't "better".
const RATING_VOTES = 3000;
const AVERAGE_RATING = 6.7;
const weightedRating = (movie) => {
  const votes = movie.details?.votes ?? movie.votes ?? 0;
  return (votes / (votes + RATING_VOTES)) * (movie.rating ?? 0) + (RATING_VOTES / (votes + RATING_VOTES)) * AVERAGE_RATING;
};

// Words too common to tell two stories apart.
const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have having he
  her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor
  not now of off on once only or other our ours out over own same she should so some such than that the their
  theirs them themselves then there these they this those through to too under until up very was we were what
  when where which while who whom why will with would you your yours yourself yourselves one two three new
  film movie story life world man woman men women young old year years day days time must find finds get gets
  becomes become takes take make makes way back when while along soon after first last own around ever every
  his her their himself herself who whose upon into onto against within without yet still even`.split(/\s+/),
);

const words = (text) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, ""))
    // A rough stem: "heists" and "heist" are the same word.
    .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

// The pool's descriptions as TF-IDF vectors, built once per pool.
let index = null; // { list, seenIn: Map(word → n), vectors: Map(id → Map(word → weight)) }
const getIndex = () => {
  const list = getAllMovies();
  if (index?.list === list) return index;
  const seenIn = new Map();
  const docs = list.map((movie) => [movie.id, words(movie.description)]);
  docs.forEach(([, terms]) => new Set(terms).forEach((term) => seenIn.set(term, (seenIn.get(term) ?? 0) + 1)));
  index = { list, seenIn, vectors: new Map() };
  docs.forEach(([id, terms]) => index.vectors.set(id, toVector(terms)));
  return index;
};
// A description's words, weighted (rarer across the pool is more) and
// normalised — for any film, pool or not.
const toVector = (terms) => {
  const { list, seenIn } = index;
  const counts = new Map();
  terms.forEach((term) => counts.set(term, (counts.get(term) ?? 0) + 1));
  const vector = new Map();
  let norm = 0;
  counts.forEach((count, term) => {
    const weight = (1 + Math.log(count)) * Math.log((list.length + 1) / ((seenIn.get(term) ?? 0) + 1));
    vector.set(term, weight);
    norm += weight * weight;
  });
  norm = Math.sqrt(norm) || 1;
  vector.forEach((weight, term) => vector.set(term, weight / norm));
  return vector;
};
const vectorOf = (movie) => getIndex().vectors.get(movie.id) ?? toVector(words(movie.description));

// How alike two weighted lists are (0–1), and the items that carry it.
const cosine = (a, b) => {
  let value = 0;
  const shared = [];
  a.forEach((weight, term) => {
    const other = b.get(term);
    if (other) {
      value += weight * other;
      shared.push([term, weight * other]);
    }
  });
  shared.sort((x, y) => y[1] - x[1]);
  return { value, items: shared.map(([term]) => term) };
};

// How telling a keyword is: rarer is more, tone tags less.
const topicWeight = (keyword) => keywordWeight(keyword) * (TONES.has(keyword) ? TONE_WEIGHT : 1);
const keywordWords = (keyword) => keyword.split(/[^a-z]+/).filter((word) => word.length >= 5);

// How much of `mine` (a film's keywords) the other film covers (0–1): its
// most telling ones, each counted by how telling it is — fully when the
// other has it, partly when they share a word. → { value, items }.
const topicsOf = (mine, theirs) => {
  const top = [...mine].sort((a, b) => topicWeight(b) - topicWeight(a)).slice(0, TOPIC_TOP);
  const total = top.reduce((sum, keyword) => sum + topicWeight(keyword), 0);
  if (total === 0) return { value: 0, items: [] };
  const exact = new Set(theirs);
  const theirWords = new Set(theirs.flatMap(keywordWords));
  let covered = 0;
  const items = [];
  [...mine]
    .sort((a, b) => topicWeight(b) - topicWeight(a))
    .forEach((keyword) => {
      if (exact.has(keyword)) {
        covered += topicWeight(keyword);
        items.push(keyword);
      } else if (keywordWords(keyword).some((word) => theirWords.has(word))) {
        covered += topicWeight(keyword) * WORD_MATCH;
      }
    });
  return { value: Math.min(1, covered / total), items: items.filter((keyword) => !TONES.has(keyword)) };
};

const dimsOf = (movie) => movie.vibe?.dims ?? NEUTRAL_DIMS;
const overlap = (a = [], b = []) => a.filter((item) => b.includes(item));
const genreWeight = (genre) => (BROAD_GENRES.has(genre) ? 0.5 : 1);
const sumGenres = (genres) => genres.reduce((sum, genre) => sum + genreWeight(genre), 0);

// The supporting signals (everything but fans and topics), for any film.
const supportOf = (movie, mine, other) => {
  const distance = Math.sqrt(dimsOf(other).reduce((sum, value, i) => sum + (value - mine.dims[i]) ** 2, 0));
  const rawFeel = 1 - distance / MAX_DISTANCE;
  const sure = movie.vibeSource === "hand" && other.vibeSource === "hand";
  const story = cosine(mine.vector, vectorOf(other));
  const sharedGenres = overlap(mine.genres, other.genres);
  const allGenres = [...new Set([...mine.genres, ...(other.genres ?? [])])];
  const sharedCast = overlap(mine.cast, (other.cast ?? []).slice(0, 6));
  return {
    signals: {
      feel: sure ? rawFeel : 0.5 + (rawFeel - 0.5) * ESTIMATED_FEEL,
      genres: allGenres.length ? sumGenres(sharedGenres) / sumGenres(allGenres) : 0,
      story: Math.min(1, story.value / STORY_FULL),
      cast: Math.min(1, sharedCast.length * 0.5),
      era: movie.year && other.year ? Math.max(0, 1 - Math.abs(movie.year - other.year) / ERA_SPAN) : 0,
      rating: Math.max(0, Math.min(1, (weightedRating(other) - 6.5) / 2)),
    },
    shared: { story: story.items.slice(0, 3), genres: sharedGenres, cast: sharedCast.slice(0, 2) },
  };
};
const scoreOf = (signals) =>
  Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + weight * (signals[key] ?? 0), 0);

// How similar, as a percent: the signals that say what the two films share
// (not quality), weighted, then scaled so a very close match reads around
// 90% and a loose one around 40%.
const SHARED = ["fans", "topics", "feel", "genres", "story", "cast", "era"];
const SHARED_WEIGHT = SHARED.reduce((sum, key) => sum + WEIGHTS[key], 0);
const SHARE_NONE = 0.15;
const SHARE_FULL = 0.85;
const percentOf = (signals) => {
  const share = SHARED.reduce((sum, key) => sum + WEIGHTS[key] * signals[key], 0) / SHARED_WEIGHT;
  return Math.max(1, Math.min(99, Math.round((100 * (share - SHARE_NONE)) / (SHARE_FULL - SHARE_NONE))));
};
const rounded = (signals) =>
  Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, Math.round(value * 100) / 100]));

// TMDB's recommendations for it, best first (ids), or none without TMDB.
const fansOf = async (movieId) => {
  try {
    const data = await tmdbGet(`/movie/${movieId}/recommendations`, { language: "en-US" }, { ttl: DAY });
    return [...new Set((data?.results ?? []).filter((result) => !result.adult).map((result) => String(result.id)))].slice(
      0,
      FANS_MAX,
    );
  } catch {
    return [];
  }
};

// Well-known films carrying any of these keywords (TMDB ids), or none.
const topicFilmsOf = async (keywordIds) => {
  if (keywordIds.length === 0) return [];
  try {
    const data = await tmdbGet(
      "/discover/movie",
      { with_keywords: keywordIds.join("|"), sort_by: "vote_count.desc", include_adult: "false", language: "en-US" },
      { ttl: DAY },
    );
    return (data?.results ?? []).map((result) => String(result.id)).slice(0, TOPIC_CANDIDATES);
  } catch {
    return [];
  }
};

// The films most like `movie`, best first: [{ id, score, percent, signals,
// shared, reasons }] — `percent` how similar (1–99), `signals` each part
// 0–1, `shared` what they have in common ({ topics, story, genres, cast }),
// `reasons` [{ key, value? }] the strongest parts, strongest first.
// `sameDirector`: keep the director's other films in.
export const findSimilar = async (movie, { count = 20, sameDirector = false } = {}) => {
  const mine = {
    dims: dimsOf(movie),
    genres: movie.genres ?? [],
    cast: (movie.cast ?? []).slice(0, 6),
    vector: vectorOf(movie),
  };
  const keep = (other) =>
    other &&
    other.id !== movie.id &&
    (sameDirector || !movie.director || other.director !== movie.director);

  // Candidates: what fans went on to like, films about the same things
  // (its rarest keywords), and the closest of the pool.
  const myKeywords = (await getKeywords([movie.id])).get(movie.id) ?? [];
  const rarest = [...myKeywords]
    .filter((keyword) => keyword.id != null && !TONES.has(keyword.name))
    .sort((a, b) => keywordWeight(b.name) - keywordWeight(a.name))
    .slice(0, TOPIC_KEYWORDS)
    .map((keyword) => keyword.id);
  const [fanIds, topicIds] = await Promise.all([fansOf(movie.id), topicFilmsOf(rarest)]);
  let fetched = [];
  try {
    fetched = (await ensureMovies([...fanIds, ...topicIds])).filter(keep);
  } catch {
    // TMDB stopped answering: carry on with the pool.
  }
  const fanRank = new Map(fanIds.map((id, index) => [id, index]));
  // Asked for the director's films too: theirs in the pool join in.
  const directorPicks =
    sameDirector && movie.director
      ? getAllMovies().filter((other) => other.id !== movie.id && other.director === movie.director)
      : [];
  const poolPicks = getAllMovies()
    .filter(keep)
    .map((other) => ({ other, score: scoreOf(supportOf(movie, mine, other).signals) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL_CANDIDATES)
    .map(({ other }) => other);
  const candidates = [
    ...new Map([...fetched, ...directorPicks, ...poolPicks].map((other) => [other.id, other])).values(),
  ];

  // What each is about.
  const keywords = await getKeywords([movie.id, ...candidates.map((other) => other.id)]);
  const namesOf = (id) => (keywords.get(id) ?? []).map((keyword) => keyword.name);
  const myTopics = namesOf(movie.id);

  return candidates
    .map((other) => {
      const support = supportOf(movie, mine, other);
      const topics = topicsOf(myTopics, namesOf(other.id));
      const topicsSignal = Math.min(1, topics.value / TOPICS_FULL);
      const rank = fanRank.get(other.id);
      const recommended = rank == null ? 0 : 1 - (rank / Math.max(1, fanIds.length)) * 0.5;
      // Fans count fully only when the films share what they're about.
      const about = Math.max(topicsSignal, support.signals.story);
      const signals = {
        fans: recommended * (FANS_ALONE + (1 - FANS_ALONE) * about),
        topics: topicsSignal,
        ...support.signals,
      };
      const shared = { topics: topics.items.slice(0, 3), ...support.shared };
      const reasons = Object.keys(REASON_AT)
        .filter((key) => signals[key] >= REASON_AT[key] && (!shared[key] || shared[key].length > 0))
        .sort((a, b) => WEIGHTS[b] * signals[b] - WEIGHTS[a] * signals[a])
        .map((key) => (shared[key] ? { key, value: shared[key] } : { key }));
      return {
        id: other.id,
        score: scoreOf(signals),
        percent: percentOf(signals),
        signals: rounded(signals),
        shared,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
};
