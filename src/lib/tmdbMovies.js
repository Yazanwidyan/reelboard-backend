import { imageUrl } from "./tmdb.js";

// TMDB records → ReelBoard movies, in the catalog's shape:
//   { id, title, year, rating, runtime, genres, director, cast, details,
//     description, franchise, poster, backdrop, vibe }
// A movie's id is its TMDB id, as a string ("603" is The Matrix).

export const CAST_PER_MOVIE = 4;
const CAST_DETAILS = 12;

// TMDB's genre ids → the app's 12 genres. The rest (war, history, family,
// music, western, documentary) aren't genres in the app; they feed a
// movie's themes and vibe instead.
export const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  18: "Drama",
  14: "Fantasy",
  27: "Horror",
  9648: "Mystery",
  10749: "Romance",
  878: "Sci-Fi",
  53: "Thriller",
};
const EXTRA_GENRES = {
  99: "Documentary",
  10751: "Family",
  36: "History",
  10402: "Music",
  10770: "TV Movie",
  10752: "War",
  37: "Western",
};
export const GENRE_IDS = Object.fromEntries(
  Object.entries(TMDB_GENRES).map(([id, name]) => [name, Number(id)]),
);

const genreIdsOf = (record) => record.genre_ids ?? record.genres?.map((genre) => genre.id) ?? [];
export const genresOf = (record) => {
  const genres = genreIdsOf(record).map((id) => TMDB_GENRES[id]).filter(Boolean);
  return genres.length > 0 ? genres : ["Drama"];
};
const extraGenresOf = (record) => genreIdsOf(record).map((id) => EXTRA_GENRES[id]).filter(Boolean);

const yearOf = (record) => Number(record.release_date?.slice(0, 4)) || null;
const round1 = (value) => Math.round((value ?? 0) * 10) / 10;

// "The Dark Knight Collection" → "The Dark Knight" (the app's franchise).
export const franchiseOf = (collection) =>
  collection?.name?.replace(/\s*[-–]?\s*Collection$/i, "").trim() || null;

// The official YouTube trailer, else any trailer, else a teaser.
export const pickTrailer = (videos = []) => {
  const rank = (video) =>
    (video.type === "Trailer" ? 0 : video.type === "Teaser" ? 2 : 4) + (video.official ? 0 : 1);
  return (
    videos
      .filter((video) => video.site === "YouTube" && rank(video) < 4)
      .sort((a, b) => rank(a) - rank(b))[0]?.key ?? null
  );
};

export const usCertification = (releaseDates) =>
  releaseDates?.results
    ?.find((country) => country.iso_3166_1 === "US")
    ?.release_dates?.map((release) => release.certification)
    .find(Boolean) ?? null;

// ---- Vibes ---------------------------------------------------------------------
//
// The six Taste DNA scores (1–5) for a movie nobody tagged by hand, from a
// ridge regression learnt from the hand-tagged pool: genres, runtime, year,
// rating, age rating and a few plot words. `train` is given the hand-tagged
// movies and the theme vocabulary when the catalog loads.

const normalize = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const GENRE_LIST = Object.values(TMDB_GENRES).sort();
const KEYWORDS = [
  /\b(murder|kill|death|dead|war)\w*/,
  /\b(love|romance|wedding)\b/,
  /\b(family|friend)\w*/,
  /\b(dream|memory|mind|reality|time)\b/,
  /\b(world|empire|galaxy|kingdom|planet)\b/,
  /\b(magic|ghost|demon|alien|monster|robot)\w*/,
  /\b(chase|escape|race|fight|battle)\w*/,
];

const features = (movie, extraGenres = []) => {
  const text = normalize(movie.description);
  const rated = movie.details?.rated ?? "";
  return [
    1,
    ...GENRE_LIST.map((genre) => (movie.genres.includes(genre) ? 1 : 0)),
    ((movie.runtime || 110) - 120) / 30,
    ((movie.year || 2000) - 1990) / 30,
    ((movie.rating || 7) - 7.5) / 1,
    /^R|NC-17/.test(rated) ? 1 : 0,
    /^G|PG$/.test(rated) ? 1 : 0,
    extraGenres.includes("War") ? 1 : 0,
    extraGenres.includes("History") ? 1 : 0,
    extraGenres.includes("Family") ? 1 : 0,
    ...KEYWORDS.map((pattern) => (pattern.test(text) ? 1 : 0)),
  ];
};

// Ridge regression: solve (XᵀX + λI) w = Xᵀy.
const fit = (rows, targets, lambda = 1) => {
  const p = rows[0].length;
  const a = Array.from({ length: p }, (_, i) =>
    Array.from(
      { length: p },
      (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? lambda : 0),
    ),
  );
  const b = Array.from({ length: p }, (_, i) => rows.reduce((sum, row, n) => sum + row[i] * targets[n], 0));
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < p; r += 1) {
      if (r === col || a[col][col] === 0) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c < p; c += 1) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }
  return b.map((value, i) => (a[i][i] === 0 ? 0 : value / a[i][i]));
};

const predict = (weights, row) => row.reduce((sum, value, i) => sum + value * weights[i], 0);
const toScore = (value) => Math.max(1, Math.min(5, Math.round(value)));

// Genres / plot words → themes the catalog knows (up to 3).
const GENRE_THEMES = { War: "war", History: "true", Music: "music", Western: "western", Family: "family" };
const PLOT_THEMES = [
  ["heist", /\b(heist|robbery|rob|steal|con artist|swindle)\b/],
  ["revenge", /\b(revenge|vengeance|avenge)/],
  ["coming-of-age", /\b(teen|teenage|adolescen|high school|coming of age|growing up)\b/],
  ["friendship", /\bfriend(s|ship)?\b/],
  ["love", /\b(love|romance|falls for|marriage|wedding)\b/],
  ["family", /\b(family|father|mother|son|daughter|siblings?|brother|sister)\b/],
  ["true", /\b(true story|real life|based on)\b/],
  ["crime", /\b(gangster|mob|mafia|cartel|drug lord|criminal)\b/],
  ["killer", /\b(serial killer|murderer|killer|slasher)\b/],
  ["detective", /\b(detective|investigat|inspector|cop)\w*/],
  ["supernatural", /\b(ghost|demon|haunt|possess|witch|curse|spirit)\w*/],
  ["monster", /\b(monster|creature|beast|shark|dinosaur|kaiju)\w*/],
  ["survival", /\b(surviv|stranded|trapped)\w*/],
  ["space", /\b(space|planet|astronaut|galaxy|mars)\b/],
  ["ai", /\b(robot|artificial intelligence|android|cyborg)\w*/],
  ["time", /\b(time travel|time loop|the past|the future)\b/],
  ["dystopia", /\b(dystopia|totalitarian|post apocalyptic|apocalypse)\w*/],
  ["chase", /\b(chase|on the run|pursu)\w*/],
  ["spy", /\b(spy|agent|cia|mi6|espionage)\b/],
  ["superhero", /\b(superhero|super hero|super powers|avengers|mutant)\w*/],
  ["quest", /\b(quest|journey|adventure)\b/],
  ["fairy-tale", /\b(princess|fairy|kingdom|magic)\w*/],
  ["sports", /\b(boxer|team|champion|coach|football|baseball|basketball)\b/],
  ["school", /\b(school|teacher|student|college)\b/],
  ["prison", /\b(prison|inmate|jail)\b/],
  ["aliens", /\b(alien|extraterrestrial)\w*/],
  ["road", /\broad trip\b/],
  ["conspiracy", /\b(conspiracy|cover up)\b/],
  ["showbiz", /\b(hollywood|actor|actress|film industry|stardom)\b/],
  ["dreams", /\b(dream|memor(y|ies)|mind)\b/],
  ["grief", /\b(grief|grieving|death of|loss of)\b/],
  ["obsession", /\bobsess\w*/],
];

let model = null; // { weights: number[][], themes: Set<string> }

export const trainVibes = (handTagged, themeVocabulary = {}) => {
  const usable = handTagged.filter((movie) => movie.vibe?.dims?.length === 6);
  if (usable.length < 20) {
    model = null;
    return;
  }
  const rows = usable.map((movie) => features(movie));
  model = {
    weights: [0, 1, 2, 3, 4, 5].map((d) => fit(rows, usable.map((movie) => movie.vibe.dims[d]))),
    themes: new Set(Object.keys(themeVocabulary)),
  };
};

const themesFor = (genres, extraGenres, description) => {
  const text = normalize(description);
  const themes = [];
  const add = (theme) => {
    if (themes.length < 3 && !themes.includes(theme) && (!model || model.themes.has(theme))) themes.push(theme);
  };
  extraGenres.forEach((genre) => GENRE_THEMES[genre] && add(GENRE_THEMES[genre]));
  if (genres.includes("Crime")) add("crime");
  for (const [theme, pattern] of PLOT_THEMES) if (pattern.test(text)) add(theme);
  return themes;
};

export const estimateVibe = (movie, extraGenres = []) => ({
  dims: model
    ? model.weights.map((weights) => toScore(predict(weights, features(movie, extraGenres))))
    : [3, 3, 3, 3, 3, 3],
  themes: themesFor(movie.genres, extraGenres, movie.description),
});

// ---- Records → movies ----------------------------------------------------------

// A full movie from GET /movie/{id}?append_to_response=credits,videos,release_dates.
export const toMovie = (record) => {
  const crew = record.credits?.crew ?? [];
  const cast = [...(record.credits?.cast ?? [])].sort((a, b) => a.order - b.order);
  const directors = crew.filter((person) => person.job === "Director");
  const movie = {
    id: String(record.id),
    title: record.title,
    year: yearOf(record),
    rating: round1(record.vote_average),
    runtime: record.runtime || null,
    genres: genresOf(record),
    director: directors[0]?.name ?? null,
    cast: cast.slice(0, CAST_PER_MOVIE).map((person) => person.name),
    details: {
      tmdbId: record.id,
      imdbId: record.imdb_id || null,
      originalTitle: record.original_title !== record.title ? record.original_title : null,
      originalLanguage: record.original_language ?? null,
      tagline: record.tagline || null,
      releaseDate: record.release_date || null,
      rated: usCertification(record.release_dates),
      language: record.spoken_languages?.map((language) => language.english_name).join(", ") || null,
      country: record.production_countries?.map((country) => country.name).join(", ") || null,
      budget: record.budget || null,
      revenue: record.revenue || null,
      votes: record.vote_count ?? 0,
      popularity: record.popularity ?? 0,
      trailer: pickTrailer(record.videos?.results),
      collection: record.belongs_to_collection
        ? { id: record.belongs_to_collection.id, name: record.belongs_to_collection.name }
        : null,
      directors: directors.map((person) => ({ id: person.id, name: person.name })),
      writers:
        crew
          .filter((person) => person.department === "Writing")
          .map((person) => person.name)
          .filter((name, i, all) => all.indexOf(name) === i)
          .slice(0, 4)
          .join(", ") || null,
      castDetails: cast.slice(0, CAST_DETAILS).map((person) => ({
        id: person.id,
        name: person.name,
        character: person.character || null,
        photo: imageUrl(person.profile_path, "w185"),
      })),
    },
    description: record.overview || "",
    franchise: franchiseOf(record.belongs_to_collection),
    poster: imageUrl(record.poster_path, "w500"),
    backdrop: imageUrl(record.backdrop_path, "w1280"),
  };
  movie.vibe = estimateVibe(movie, extraGenresOf(record));
  movie.vibeSource = "estimated";
  return movie;
};

// A list entry (search, browse, similar): enough to show a poster and open
// the movie.
export const toSummary = (record) => ({
  id: String(record.id),
  title: record.title,
  year: yearOf(record),
  rating: round1(record.vote_average),
  votes: record.vote_count ?? 0,
  genres: genresOf(record),
  poster: imageUrl(record.poster_path, "w342"),
  backdrop: imageUrl(record.backdrop_path, "w780"),
  description: record.overview || "",
});

// A person in a list (search, credits).
export const toPersonSummary = (record) => ({
  id: String(record.id),
  name: record.name,
  photo: imageUrl(record.profile_path, "w185"),
  knownFor: record.known_for_department ?? null,
  knownForTitles: (record.known_for ?? [])
    .filter((item) => item.media_type === "movie")
    .map((item) => item.title)
    .slice(0, 3),
});
