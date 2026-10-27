import { Router } from "express";
import { all, fromJSON, get } from "../db/index.js";
import { getCollection } from "../lib/collections.js";
import { toBoard } from "../lib/library.js";
import { getMovieById } from "../lib/movies.js";
import { titleName } from "../lib/titles.js";
import { isSuspended } from "../lib/users.js";

// ReelBoard pages anyone can open in a browser — what a shared link shows
// (links come from routes/shares.js):
//
//   /m/:id      a movie
//   /c/:id      a collection
//   /s/:token   someone's list or profile, shared on purpose
//
// Plain HTML from the server, in the app's colours, with Open Graph tags so
// the link unfurls into a card in chats. Each has a way into the app
// (reelboard://…). Nothing private: a list or a profile only shows through
// a link its owner made, and stops when they take it back or the account
// is suspended or gone.
const router = Router();

// A movie by id, or null — also for no id (an empty list's first film).
const movieOf = (id) => (id ? getMovieById(id) : null);

const escape = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #14181c; color: #fff; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
a { color: inherit; }
.page { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }
.brand { font-family: "Bebas Neue", Inter, sans-serif; font-size: 28px; letter-spacing: 0.8px; text-decoration: none; }
.hero { display: flex; gap: 18px; align-items: flex-end; margin: 28px 0 20px; }
.hero img.poster { width: 120px; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; flex: none; }
.eyebrow { color: #99aabb; font-size: 12px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; }
h1 { font-size: 28px; line-height: 1.15; margin: 4px 0 6px; }
.meta { color: #99aabb; font-size: 14px; }
.about { color: #ccd6e0; margin: 0 0 22px; }
.open { display: inline-block; background: #fff; color: #14181c; font-weight: 700; padding: 12px 20px; border-radius: 8px; text-decoration: none; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 22px 0; }
.grid a { display: block; text-decoration: none; }
.grid img, .grid .blank { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; background: #2c3440; display: block; }
.grid span { display: block; font-size: 12px; color: #99aabb; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ranks { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 18px; }
.ranks span { background: #2c3440; border-radius: 6px; padding: 3px 10px; font-size: 13px; }
.avatar { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; display: grid; place-items: center; font-size: 30px; font-weight: 800; color: #14181c; flex: none; }
.counts { display: flex; gap: 22px; margin: 6px 0 20px; }
.counts strong { display: block; font-size: 20px; }
.counts span { color: #99aabb; font-size: 13px; }
.foot { color: #8899aa; font-size: 13px; margin-top: 28px; }
`;

// A whole page. `og`: { title, description, image } for the link's card;
// `open`: the reelboard:// link and the button's words; `index`: whether
// search engines may list it.
const page = ({ title, description, image, open, body, index = true }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)} · ReelBoard</title>
${index ? "" : '<meta name="robots" content="noindex" />'}
<meta name="description" content="${escape(description)}" />
<meta property="og:site_name" content="ReelBoard" />
<meta property="og:title" content="${escape(title)}" />
<meta property="og:description" content="${escape(description)}" />
${image ? `<meta property="og:image" content="${escape(image)}" />` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet" />
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<a class="brand" href="${escape(open.url)}">ReelBoard</a>
${body}
<p><a class="open" href="${escape(open.url)}">${escape(open.label)}</a></p>
<p class="foot">Tier the films you watch, find tonight's pick, and see how your taste stacks up — on ReelBoard.</p>
</div>
</body>
</html>`;

const notThere = (res, what = "This page") =>
  res.status(404).type("html").send(
    page({
      title: "Not found",
      description: `${what} isn't available.`,
      open: { url: "reelboard://", label: "Open ReelBoard" },
      body: `<h1>Not here</h1><p class="about">${escape(what)} isn't available — it may have been taken down.</p>`,
      index: false,
    }),
  );

// A grid of posters, each opening the film's own page.
const posterGrid = (movieIds) =>
  `<div class="grid">${movieIds
    .map(getMovieById)
    .filter(Boolean)
    .map(
      (movie) =>
        `<a href="/m/${escape(movie.id)}">${
          movie.poster ? `<img src="${escape(movie.poster)}" alt="" loading="lazy" />` : '<div class="blank"></div>'
        }<span>${escape(movie.title)}</span></a>`,
    )
    .join("")}</div>`;

// Movies and collections are the same for everyone; a shared list or
// profile changes, and is someone's, so it isn't kept by shared caches.
const send = (res, html, cache = "public, max-age=300") => res.type("html").set("Cache-Control", cache).send(html);
const PRIVATE = "private, max-age=60";

// ---- A movie

router.get("/m/:id", (req, res) => {
  const movie = /^\d{1,10}$/.test(req.params.id) ? getMovieById(req.params.id) : null;
  if (!movie) return notThere(res, "This movie");
  const meta = [movie.year, movie.director && `Directed by ${movie.director}`, movie.runtime && `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m`]
    .filter(Boolean)
    .join(" · ");
  send(
    res,
    page({
      title: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
      description: movie.description || meta,
      image: movie.backdrop ?? movie.poster,
      open: { url: `reelboard://movie/${movie.id}`, label: "Open in ReelBoard" },
      body: `<div class="hero">${movie.poster ? `<img class="poster" src="${escape(movie.poster)}" alt="" />` : ""}<div>
<div class="eyebrow">Movie</div><h1>${escape(movie.title)}</h1><div class="meta">${escape(meta)}</div></div></div>
${movie.description ? `<p class="about">${escape(movie.description)}</p>` : ""}`,
    }),
  );
});

// ---- A collection

router.get("/c/:id", (req, res) => {
  const collection = getCollection(req.params.id);
  if (!collection) return notThere(res, "This collection");
  const art = collection.art?.backdrop ?? collection.art?.photo ?? movieOf(collection.movieIds[0])?.backdrop ?? null;
  const ranks = (collection.ranks ?? [])
    .map((rank, index, list) => `<span>${escape(rank.title)} · ${index === list.length - 1 ? "every film" : `${rank.at} films`}</span>`)
    .join("");
  send(
    res,
    page({
      title: collection.title,
      description: `${collection.subtitle ? `${collection.subtitle} — ` : ""}${collection.movieIds.length} films to watch on ReelBoard.`,
      image: art,
      open: { url: `reelboard://collection/${encodeURIComponent(collection.id)}`, label: "Start it in ReelBoard" },
      body: `<div class="hero"><div><div class="eyebrow">Collection · ${collection.movieIds.length} films</div>
<h1>${escape(collection.title)}</h1>${collection.subtitle ? `<div class="meta">${escape(collection.subtitle)}</div>` : ""}</div></div>
${ranks ? `<div class="ranks">${ranks}</div>` : ""}${posterGrid(collection.movieIds)}`,
    }),
  );
});

// ---- Someone's list or profile, through their link

const shared = (token) => {
  const link = get("SELECT * FROM share_links WHERE token = ? AND revoked_at IS NULL", [token]);
  if (!link) return null;
  const owner = get("SELECT * FROM users WHERE id = ?", [link.user_id]);
  return owner && !isSuspended(owner) ? { link, owner } : null;
};

const listPage = (owner, boardRow) => {
  const board = toBoard(boardRow);
  const first = movieOf(board.movieIds[0]);
  return page({
    title: `${board.name} — a list by ${owner.display_name}`,
    description: `${board.movieIds.length} films on ${owner.display_name}'s list on ReelBoard.`,
    image: first?.backdrop ?? first?.poster ?? null,
    open: { url: "reelboard://", label: "Make your own list in ReelBoard" },
    index: false,
    body: `<div class="hero"><div><div class="eyebrow">${escape(owner.display_name)}'s list · ${board.movieIds.length} films</div>
<h1>${escape(board.name)}</h1><div class="meta">@${escape(owner.handle)}</div></div></div>${posterGrid(board.movieIds)}`,
  });
};

const profilePage = (owner) => {
  const watched = get("SELECT COUNT(*) AS n FROM watched WHERE user_id = ?", [owner.id]).n;
  const sTier = get("SELECT COUNT(*) AS n FROM watched WHERE user_id = ? AND tier = 'S'", [owner.id]).n;
  const topTen = fromJSON(owner.top_ten, []);
  const favourites = topTen.length
    ? topTen
    : all("SELECT movie_id FROM watched WHERE user_id = ? AND tier = 'S' ORDER BY watched_at DESC LIMIT 10", [owner.id]).map((row) => row.movie_id);
  const avatar = /^https?:/.test(owner.avatar_uri ?? "")
    ? `<img class="avatar" src="${escape(owner.avatar_uri)}" alt="" />`
    : `<div class="avatar" style="background:${escape(owner.color)}">${escape(owner.display_name.slice(0, 1).toUpperCase())}</div>`;
  return page({
    title: `${owner.display_name} (@${owner.handle})`,
    description: `${titleName(owner.level)} on ReelBoard · ${watched} films watched, ${sTier} in S tier.`,
    image: movieOf(favourites[0])?.backdrop ?? null,
    open: { url: "reelboard://friends", label: `Add @${owner.handle} on ReelBoard` },
    index: false,
    body: `<div class="hero">${avatar}<div><div class="eyebrow">${escape(titleName(owner.level))}</div>
<h1>${escape(owner.display_name)}</h1><div class="meta">@${escape(owner.handle)}</div></div></div>
${owner.bio ? `<p class="about">${escape(owner.bio)}</p>` : ""}
<div class="counts"><div><strong>${watched}</strong><span>watched</span></div><div><strong>${sTier}</strong><span>in S tier</span></div><div><strong>${owner.ranks ?? 0}</strong><span>ranks</span></div></div>
${favourites.length ? `<div class="eyebrow">Their S tier</div>${posterGrid(favourites)}` : ""}`,
  });
};

router.get("/s/:token", (req, res) => {
  const found = /^[A-Za-z0-9_-]{6,64}$/.test(req.params.token) ? shared(req.params.token) : null;
  if (!found) return notThere(res, "This link");
  const { link, owner } = found;
  if (link.type === "list") {
    const board = get("SELECT * FROM boards WHERE id = ? AND user_id = ?", [link.target_id, owner.id]);
    if (!board) return notThere(res, "This list");
    return send(res, listPage(owner, board), PRIVATE);
  }
  send(res, profilePage(owner), PRIVATE);
});

export default router;
