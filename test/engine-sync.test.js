import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// The taste engine lives twice: in the app (utils/tasteEngine — tonight's
// pick) and here (lib/candidates — the Swipe deck). Their numbers have to
// agree, or Swipe and the picks drift apart. Skipped when the app isn't
// checked out next to the backend.

const APP = new URL("../../Reelboard/src/utils/tasteEngine.js", import.meta.url);
const SERVER = new URL("../src/lib/candidates.js", import.meta.url);

// A `const NAME = …;` from the source, evaluated (numbers and plain
// objects only).
const constant = (source, name) => {
  const match = source.match(new RegExp(`^const ${name} = ([\\s\\S]*?);$`, "m"));
  assert.ok(match, `${name} not found`);
  return Function(`return (${match[1]});`)();
};

test("the app's taste engine and the server's copy use the same numbers", { skip: !fs.existsSync(APP) }, () => {
  const app = fs.readFileSync(APP, "utf8");
  const server = fs.readFileSync(SERVER, "utf8");
  for (const name of [
    "TIER_WEIGHT",
    "UNTIERED_WEIGHT",
    "NEAREST_COUNT",
    "NEAREST_CENTER",
    "FINGERPRINT_CENTER",
    "PASS_WEIGHT",
    "LEANING_ALONE",
    "LEANING_NUDGE",
    "OPEN_DIMENSION_WEIGHT",
  ]) {
    assert.deepEqual(constant(server, name), constant(app, name), name);
  }
  // The signals both score with weigh the same.
  const appWeights = constant(app, "WEIGHTS");
  const serverWeights = constant(server, "WEIGHTS");
  for (const [signal, weight] of Object.entries(serverWeights)) {
    if (signal in appWeights) assert.equal(weight, appWeights[signal], `WEIGHTS.${signal}`);
  }
});
