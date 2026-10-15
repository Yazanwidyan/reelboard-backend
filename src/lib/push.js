import { all, get, run } from "../db/index.js";

// Push notifications through Expo's push service
// (https://docs.expo.dev/push-notifications/sending-notifications/). The app
// registers each phone's Expo push token (POST /api/me/push-tokens); this
// sends to every phone of the given people, in their own language, and
// forgets tokens Expo says are gone. Sending never blocks or fails the
// request that triggered it.

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
};

const languageOf = (userId) =>
  get("SELECT language FROM user_state WHERE user_id = ?", [userId])?.language === "ar" ? "ar" : "en";

// `kind`: a key of TEXT. `args`: passed to its text. `url`: opened on tap
// (a reelboard:// link the app knows).
export const notify = (userIds, kind, args = [], url = null) => {
  const messages = [];
  for (const userId of new Set(userIds)) {
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
