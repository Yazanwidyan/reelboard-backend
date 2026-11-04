import { all, get, run, toJSON } from "../db/index.js";

// Push notifications through Expo's push service
// (https://docs.expo.dev/push-notifications/sending-notifications/). The app
// registers each phone's Expo push token (POST /api/me/push-tokens); this
// sends to every phone of the given people, in their own language, and
// forgets tokens Expo says are gone. Sending never blocks or fails the
// request that triggered it. Each one is also kept (the notifications
// table) for the app's Notifications page — phone or no phone.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Swappable so tests can see what would be sent without a network call.
export const pushTransport = {
  send: async (messages) => {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    return (await response.json()).data ?? [];
  },
};

// The few things the server says, in the app's two languages.
const TEXT = {
  friendRequest: {
    en: (name) => [`${name} wants to be friends`, "Compare tier lists and see what they're watching."],
    ar: (name) => [`${name} يريد أن يكون صديقك`, "قارنوا قوائم التصنيف وشاهد ما يشاهده."],
  },
  friendAccepted: {
    en: (name) => [`${name} accepted your friend request`, "See what they've been watching."],
    ar: (name) => [`${name} قبل طلب صداقتك`, "شاهد ما كان يشاهده."],
  },
  movieNightJoined: {
    en: (name) => [`${name} joined your movie night`, "Start swiping when you're ready."],
    ar: (name) => [`${name} انضمّ إلى سهرة الأفلام`, "ابدأ السحب عندما تكون جاهزاً."],
  },
  movieNightResults: {
    en: () => ["Everyone's done swiping", "See the movies you all picked."],
    ar: () => ["انتهى الجميع من السحب", "شاهد الأفلام التي اخترتموها جميعاً."],
  },
  friendLovedSaved: {
    en: (name, title) => [`${name} gave ${title} an S`, "It's on your watchlist — maybe tonight?"],
    ar: (name, title) => [`${name} صنّف ${title} في الفئة S`, "إنه في قائمة مشاهدتك — ربما الليلة؟"],
  },
};

// Kept per person: the latest this many.
const KEPT = 100;

// A kept notification's words, in `language`: [title, body].
export const notificationText = (kind, args, language) =>
  TEXT[kind]?.[language === "ar" ? "ar" : "en"](...args) ?? ["", ""];

export const languageOf = (userId) =>
  get("SELECT language FROM user_state WHERE user_id = ?", [userId])?.language === "ar" ? "ar" : "en";

// When someone gives a film an S: the friends who saved it and haven't seen
// it yet hear about it — the one push about a friend's tiers, since it's
// the one that helps decide.
export const notifyFriendsOfS = (userId, movieId, { friendIds, name, title }) => {
  if (friendIds.length === 0) return;
  const savers = all(
    `SELECT watchlist.user_id FROM watchlist
     WHERE watchlist.movie_id = ? AND watchlist.user_id IN (${friendIds.map(() => "?").join(", ")})
       AND NOT EXISTS (SELECT 1 FROM watched WHERE watched.user_id = watchlist.user_id AND watched.movie_id = ?)`,
    [movieId, ...friendIds, movieId],
  ).map((row) => row.user_id);
  notify(savers, "friendLovedSaved", [name, title], `reelboard://movie/${movieId}`, { fromUserId: userId, movieId });
};

// `kind`: a key of TEXT. `args`: passed to its text. `url`: opened on tap
// (a reelboard:// link the app knows). `fromUserId` / `movieId`: who and
// what it's about, for the Notifications page's face or poster.
export const notify = (userIds, kind, args = [], url = null, { fromUserId = null, movieId = null } = {}) => {
  const messages = [];
  const now = Date.now();
  for (const userId of new Set(userIds)) {
    run(
      `INSERT INTO notifications (user_id, kind, args, url, from_user_id, movie_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, kind, toJSON(args), url, fromUserId, movieId, now],
    );
    run(
      `DELETE FROM notifications WHERE user_id = ? AND id NOT IN
         (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${KEPT})`,
      [userId, userId],
    );
    const [title, body] = TEXT[kind][languageOf(userId)](...args);
    for (const { token } of all("SELECT token FROM push_tokens WHERE user_id = ?", [userId])) {
      messages.push({ to: token, title, body, sound: "default", data: url ? { url } : {} });
    }
  }
  if (messages.length === 0) return;
  pushTransport
    .send(messages)
    .then((tickets) => {
      tickets.forEach((ticket, i) => {
        if (ticket?.details?.error === "DeviceNotRegistered") {
          run("DELETE FROM push_tokens WHERE token = ?", [messages[i].to]);
        }
      });
    })
    .catch((error) => console.warn(`Push not sent: ${error.message}`));
};
