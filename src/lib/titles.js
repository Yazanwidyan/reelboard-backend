// Your title, by how many ranks you have (lib/ranks.js) — the same ladder
// as the app's (src/utils/ranks.js).
// A night at the theatre, from walking in to keeping the archive. There are
// 39 ranks in all, so Archivist needs nearly every one.
export const TITLES = [
  { at: 0, name: "Walk-in" },
  { at: 3, name: "Regular" },
  { at: 8, name: "Front Row" },
  { at: 14, name: "Critic" },
  { at: 20, name: "Curator" },
  { at: 27, name: "Cinephile" },
  { at: 34, name: "Archivist" },
];

// 1 = Walk-in … 7 = Archivist — stored as the user's `level`, which friends see.
export const titleStepFor = (count) =>
  TITLES.reduce((step, title, index) => (count >= title.at ? index + 1 : step), 1);

export const titleName = (step) => TITLES[Math.min(Math.max(step, 1), TITLES.length) - 1].name;
