import fs from "node:fs";
import config from "../config.js";

// data/curation.json — what people chose by hand: the curated movies (with
// hand-tuned vibes and franchises), the sagas, the Reels clips, the Taste DNA
// vocabulary, and `excluded` (movies kept out of the pool). The admin site
// edits it here, so `npm run build-pool` keeps those choices, and git keeps
// them as a reviewable diff.
//
// Written in the file's own layout — one compact line per movie and per
// saga, everything else indented — so an edit changes only its own lines.

const ONE_PER_LINE = new Set(["movies", "sagas"]);

export const readCuration = () => JSON.parse(fs.readFileSync(config.curationPath, "utf8"));

export const serializeCuration = (curation) =>
  "{\n" +
  Object.entries(curation)
    .map(([key, value]) => {
      const body = ONE_PER_LINE.has(key)
        ? `[\n${value.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n ]`
        : JSON.stringify(value, null, 1).replace(/\n/g, "\n ");
      return ` ${JSON.stringify(key)}: ${body}`;
    })
    .join(",\n") +
  "\n}\n";

// Replaces the file in one step (a temporary file, then a rename), so a
// crash mid-write can't leave half a file. Keeps the file's line endings
// (git may have checked it out with Windows ones).
export const writeCuration = (curation) => {
  const existing = fs.existsSync(config.curationPath)
    ? fs.readFileSync(config.curationPath, "utf8")
    : "";
  const text = serializeCuration(curation);
  const temporary = `${config.curationPath}.tmp`;
  fs.writeFileSync(temporary, existing.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  fs.renameSync(temporary, config.curationPath);
};

// Reads, changes and writes it: `change` gets the curation to edit in place.
export const updateCuration = (change) => {
  const curation = readCuration();
  change(curation);
  writeCuration(curation);
  return curation;
};
