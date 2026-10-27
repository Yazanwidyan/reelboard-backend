// ReelBoard Pro: an account is Pro from `pro_since` until `pro_until` (no
// end when that's null), granted by an admin for now (`pro_source`
// "admin"; store purchases will set "store"). Pro unlocks the app's deeper
// taste stats and profile style — a PRO badge and an accent colour
// (`profile_accent`) that friends see too. The perks themselves are the
// app's; the server says who's Pro and keeps the accent theirs.

// The accents a Pro profile can wear (the app has their colours).
export const PRO_ACCENTS = ["slate", "green", "orange", "blue", "rose", "gold"];

export const isPro = (row, now = Date.now()) =>
  row?.pro_since != null && (row.pro_until == null || row.pro_until > now);

// As the account sees it: { active, since, until, source }.
export const proOf = (row) =>
  isPro(row)
    ? { active: true, since: row.pro_since, until: row.pro_until ?? null, source: row.pro_source ?? null }
    : { active: false, since: null, until: null, source: null };

// The accent a profile shows: only while Pro (it comes back if Pro does).
export const accentOf = (row) => (isPro(row) ? (row.profile_accent ?? null) : null);
