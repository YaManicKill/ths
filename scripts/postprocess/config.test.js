const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPostprocessConfig } = require("./config");

function rootWith(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ths-config-"));
  if (config !== null) {
    fs.writeFileSync(
      path.join(root, "postprocess.config.json"),
      JSON.stringify(config),
    );
  }
  return root;
}

// An absent config file must still yield a fully populated, valid config.
const defaults = loadPostprocessConfig(rootWith(null));
assert.equal(defaults.timezone, "Europe/London");
assert.equal(defaults.releaseTimeLocal, "19:00:00");
assert.equal(defaults.outputRoot, "content/episode");
assert.ok(defaults.episodesRoot.length > 0, "episodesRoot needs a default");
assert.ok(defaults.profanityWords.length > 0);

// File values win over defaults.
const overridden = loadPostprocessConfig(
  rootWith({ outputRoot: "somewhere/else", releaseTimeLocal: "07:30" }),
);
assert.equal(overridden.outputRoot, "somewhere/else");
assert.equal(overridden.releaseTimeLocal, "07:30");

// Configured profanity words are added to the defaults, never replacing them.
const words = loadPostprocessConfig(
  rootWith({ profanityWords: ["bananas*"] }),
).profanityWords;
assert.ok(words.includes("bananas*"), "configured word missing");
assert.ok(words.includes("fuck*"), "default word was dropped");

// Bad values must fail at load with a message naming the key, not silently or deep in Intl.
const rejected = [
  ["timezone", { timezone: "Europe/Lundon" }],
  ["releaseTimeLocal", { releaseTimeLocal: "7pm" }],
  ["releaseTimeLocal", { releaseTimeLocal: "" }],
  ["releaseTimeLocal", { releaseTimeLocal: "25:00:00" }],
  ["outputRoot", { outputRoot: "" }],
  ["episodesRoot", { episodesRoot: "   " }],
  ["defaultAuthor", { defaultAuthor: "" }],
];

for (const [key, config] of rejected) {
  assert.throws(
    () => loadPostprocessConfig(rootWith(config)),
    (error) => error.message.includes(`"${key}"`),
    `expected ${JSON.stringify(config)} to be rejected naming "${key}"`,
  );
}

console.log("config test passed", { rejectedCases: rejected.length });
