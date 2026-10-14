import { createRemoteJWKSet, jwtVerify } from "jose";
import config from "../config.js";
import { HttpError, unauthorized } from "./errors.js";

// Checks a sign-in token from Google or Apple: signed with the provider's
// published keys, issued by them, for this app, and not expired. Returns
// who it's for: { subject, email, emailVerified, name }.
//
// The app gets these tokens from the native Google / Apple sign-in sheets
// (see the app's services/socialAuth.js) and sends them here; the server
// never sees a Google or Apple password.

const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const APPLE_KEYS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

const notConfigured = (provider, variable) =>
  new HttpError(503, `${provider} sign-in isn't set up on the server yet (set ${variable})`);

const verify = async (token, keys, options) => {
  try {
    const { payload } = await jwtVerify(token, keys, options);
    return payload;
  } catch {
    throw unauthorized("That sign-in didn't go through — try again");
  }
};

// Apple and Google send email_verified as a boolean or the string "true".
const isTrue = (value) => value === true || value === "true";

export const verifiers = {
  google: async (idToken) => {
    if (config.googleClientIds.length === 0) throw notConfigured("Google", "GOOGLE_CLIENT_IDS");
    const claims = await verify(idToken, GOOGLE_KEYS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.googleClientIds,
    });
    return {
      subject: claims.sub,
      email: claims.email ?? null,
      emailVerified: isTrue(claims.email_verified),
      name: claims.name ?? null,
    };
  },

  // Apple only shares the user's name with the app, on the very first
  // sign-in — the app passes it along separately.
  apple: async (identityToken) => {
    if (config.appleClientIds.length === 0) throw notConfigured("Apple", "APPLE_CLIENT_IDS");
    const claims = await verify(identityToken, APPLE_KEYS, {
      issuer: "https://appleid.apple.com",
      audience: config.appleClientIds,
    });
    return {
      subject: claims.sub,
      email: claims.email ?? null,
      emailVerified: isTrue(claims.email_verified),
      name: null,
    };
  },
};
