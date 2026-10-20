// Your title, by how many ranks you have (lib/ranks.js) — the same ladder
// as the app's (src/utils/ranks.js).
// There are 39 ranks in all, so Legend needs nearly every one.
export const TITLES = [
  { at: 0, name: "Extra" },
  { at: 3, name: "Supporting Role" },
  { at: 8, name: "Lead" },
  { at: 14, name: "Star" },
  { at: 20, name: "Auteur" },
  { at: 27, name: "Icon" },
  { at: 34, name: "Legend" },
];

// 1 = Extra … 7 = Legend — stored as the user's `level`, which friends see.
export const titleStepFor = (count) =>
  TITLES.reduce((step, title, index) => (count >= title.at ? index + 1 : step), 1);

export const titleName = (step) => TITLES[Math.min(Math.max(step, 1), TITLES.length) - 1].name;
