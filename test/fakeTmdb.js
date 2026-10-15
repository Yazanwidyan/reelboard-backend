import http from "node:http";

// A stand-in for TMDB's API, so the tests never touch the real one. It knows
// one movie that isn't in the pool (FAKE_MOVIE_ID), a collection and a
// person; everything else is a 404. `requests` lists the paths asked for.

export const FAKE_MOVIE_ID = "424242";
export const FAKE_PERSON_ID = "777";
export const FAKE_COLLECTION_ID = "9001";

const fakeMovie = {
  id: Number(FAKE_MOVIE_ID),
  title: "The Fake Film",
  original_title: "The Fake Film",
  original_language: "en",
  release_date: "2021-06-04",
  vote_average: 7.84,
  vote_count: 4200,
  popularity: 33.3,
  runtime: 118,
  genres: [{ id: 878, name: "Science Fiction" }, { id: 53, name: "Thriller" }, { id: 10752, name: "War" }],
  imdb_id: "tt9999999",
  tagline: "Nothing is real.",
  spoken_languages: [{ english_name: "English" }],
  production_countries: [{ name: "United States of America" }],
  budget: 1000000,
  revenue: 5000000,
  belongs_to_collection: { id: Number(FAKE_COLLECTION_ID), name: "The Fake Collection" },
  overview: "A spy on the run in a dystopia discovers the war was a dream.",
  poster_path: "/fake-poster.jpg",
  backdrop_path: "/fake-backdrop.jpg",
  adult: false,
  credits: {
    cast: [
      { id: 1, name: "Ada Actor", character: "Hero", order: 0, profile_path: "/ada.jpg" },
      { id: 2, name: "Ben Bit", character: "Sidekick", order: 1, profile_path: null },
    ],
    crew: [
      { id: Number(FAKE_PERSON_ID), name: "Dee Director", job: "Director", department: "Directing" },
      { id: 4, name: "Wren Writer", job: "Screenplay", department: "Writing" },
    ],
  },
  videos: {
    results: [
      { site: "YouTube", type: "Teaser", official: true, key: "teaser123" },
      { site: "YouTube", type: "Trailer", official: true, key: "trailer123" },
    ],
  },
  release_dates: {
    results: [{ iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] }],
  },
};

const listEntry = {
  id: fakeMovie.id,
  title: fakeMovie.title,
  release_date: fakeMovie.release_date,
  vote_average: fakeMovie.vote_average,
  vote_count: fakeMovie.vote_count,
  genre_ids: [878, 53],
  poster_path: fakeMovie.poster_path,
  backdrop_path: fakeMovie.backdrop_path,
  overview: fakeMovie.overview,
  adult: false,
};
const adultEntry = { ...listEntry, id: 666, title: "Not Shown", adult: true };
const page = (results) => ({ page: 1, results, total_pages: 1, total_results: results.length });

const routes = [
  [/^\/movie\/424242$/, () => fakeMovie],
  [/^\/movie\/424242\/recommendations$/, () => page([])],
  [/^\/movie\/424242\/similar$/, () => page([listEntry])],
  [
    /^\/movie\/424242\/watch\/providers$/,
    () => ({
      results: {
        US: {
          link: "https://www.themoviedb.org/movie/424242/watch",
          flatrate: [
            { provider_id: 9, provider_name: "Second", logo_path: "/b.jpg", display_priority: 2 },
            { provider_id: 8, provider_name: "First", logo_path: "/a.jpg", display_priority: 1 },
          ],
          rent: [{ provider_id: 2, provider_name: "Rent It", logo_path: "/r.jpg", display_priority: 1 }],
        },
      },
    }),
  ],
  [/^\/search\/movie$/, (query) => page(/fake/i.test(query.get("query")) ? [listEntry, adultEntry] : [])],
  [/^\/(trending\/movie\/week|movie\/(popular|now_playing|upcoming|top_rated))$/, () => page([listEntry])],
  [/^\/discover\/movie$/, () => page([listEntry])],
  [
    /^\/collection\/9001$/,
    () => ({
      id: Number(FAKE_COLLECTION_ID),
      name: "The Fake Collection",
      overview: "Every fake film.",
      poster_path: "/c.jpg",
      backdrop_path: null,
      parts: [
        { ...listEntry, id: 2, title: "The Fake Sequel", release_date: "2024-01-01" },
        listEntry,
      ],
    }),
  ],
  [
    /^\/search\/person$/,
    () => page([{ id: 777, name: "Dee Director", profile_path: "/dee.jpg", known_for_department: "Directing", known_for: [{ media_type: "movie", title: "The Fake Film" }] }]),
  ],
  [
    /^\/person\/777$/,
    () => ({
      id: 777,
      name: "Dee Director",
      biography: "Makes fake films.",
      birthday: "1970-01-01",
      deathday: null,
      place_of_birth: "Nowhere",
      profile_path: "/dee.jpg",
      known_for_department: "Directing",
      movie_credits: {
        cast: [{ ...listEntry, character: "Cameo" }],
        crew: [
          { ...listEntry, job: "Director" },
          { ...listEntry, job: "Writer" },
          { ...listEntry, id: 2, title: "The Fake Sequel", release_date: "2024-01-01", job: "Producer" },
        ],
      },
    }),
  ],
];

export const startFakeTmdb = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname);
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end();
      return;
    }
    const route = routes.find(([pattern]) => pattern.test(url.pathname));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"status_code":34}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route[1](url.searchParams)));
  });
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => server.close(),
  };
};
