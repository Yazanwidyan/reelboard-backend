import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pickBackdrop, pickLogo, toMovie } from "../src/lib/tmdbMovies.js";

// Which of TMDB's images a movie gets: a backdrop with no text on it, and
// its title art (an English PNG logo).

const image = (file_path, iso_639_1, vote_average, extra = {}) => ({
  file_path,
  iso_639_1,
  vote_average,
  vote_count: 10,
  width: 1000,
  height: 400,
  ...extra,
});

describe("TMDB images", () => {
  test("the backdrop is the best one without text, else TMDB's own pick", () => {
    const record = {
      backdrop_path: "/default.jpg",
      images: {
        backdrops: [
          image("/with-title.jpg", "en", 9.9),
          image("/still-ok.jpg", null, 5.1),
          image("/still-best.jpg", null, 5.6),
          image("/also-textless.jpg", "xx", 5.3),
        ],
      },
    };
    assert.equal(pickBackdrop(record), "/still-best.jpg");
    assert.equal(pickBackdrop({ backdrop_path: "/default.jpg", images: { backdrops: [image("/t.jpg", "en", 9)] } }), "/default.jpg");
    assert.equal(pickBackdrop({ backdrop_path: "/default.jpg" }), "/default.jpg");
    assert.equal(pickBackdrop({}), null);
  });

  test("the logo is the best English PNG, with its shape", () => {
    const record = {
      images: {
        logos: [
          image("/fr.png", "fr", 9.9),
          image("/vector.svg", "en", 9.8),
          image("/plain.png", null, 9.0),
          image("/english.png", "en", 5.0, { width: 1278, height: 393 }),
        ],
      },
    };
    assert.deepEqual(pickLogo(record), {
      url: "https://image.tmdb.org/t/p/w500/english.png",
      aspect: 3.25,
    });
    // No English one: one with no language will do.
    assert.equal(pickLogo({ images: { logos: [image("/fr.png", "fr", 9), image("/plain.png", null, 1)] } }).url.endsWith("/plain.png"), true);
    assert.equal(pickLogo({ images: { logos: [image("/fr.png", "fr", 9)] } }), null);
    assert.equal(pickLogo({}), null);
  });

  test("toMovie uses them", () => {
    const movie = toMovie({
      id: 1,
      title: "Test",
      release_date: "2020-01-01",
      genres: [],
      backdrop_path: "/default.jpg",
      images: {
        backdrops: [image("/still.jpg", null, 6)],
        logos: [image("/logo.png", "en", 6)],
      },
    });
    assert.equal(movie.backdrop, "https://image.tmdb.org/t/p/w1280/still.jpg");
    assert.equal(movie.details.logo.url, "https://image.tmdb.org/t/p/w500/logo.png");
    assert.equal(movie.details.logo.aspect, 2.5);
  });
});
