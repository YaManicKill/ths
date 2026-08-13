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

// Words in the gitignored local overlay count too.
const localWordsRoot = rootWith({ profanityWords: ["mainword*"] });
fs.writeFileSync(
  path.join(localWordsRoot, "postprocess.config.local.json"),
  JSON.stringify({ profanityWords: ["localword*"] }),
);
const overlayWords = loadPostprocessConfig(localWordsRoot).profanityWords;
assert.ok(overlayWords.includes("localword*"), "local overlay word dropped");
assert.ok(overlayWords.includes("mainword*"), "main config word dropped");
assert.ok(overlayWords.includes("fuck*"), "default word dropped in overlay");

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

// The LLM section: defaults present, secrets overlay from the gitignored local config,
// and validation catches a bad provider before any feature runs.
const llmDefaults = loadPostprocessConfig(rootWith(null)).llm;
assert.equal(llmDefaults.provider, "gemini");
assert.ok(llmDefaults.model.length > 0);
assert.equal(llmDefaults.apiKey, null);

const llmRoot = rootWith({ llm: { model: "gemini-2.5-flash" } });
fs.writeFileSync(
  path.join(llmRoot, "postprocess.config.local.json"),
  JSON.stringify({ llm: { apiKey: "secret-key" } }),
);
const merged = loadPostprocessConfig(llmRoot);
assert.equal(merged.llm.model, "gemini-2.5-flash", "main config llm lost");
assert.equal(merged.llm.apiKey, "secret-key", "local config key not merged");
assert.equal(merged.llm.provider, "gemini", "default provider lost in merge");

assert.equal(
  loadPostprocessConfig(rootWith({ llm: { apiKey: "" } })).llm.apiKey,
  null,
  "empty api key should read as unset",
);

assert.throws(
  () => loadPostprocessConfig(rootWith({ llm: { provider: "chatgpt" } })),
  (error) => error.message.includes('"llm.provider"'),
);
assert.throws(
  () => loadPostprocessConfig(rootWith({ llm: { model: "" } })),
  (error) => error.message.includes('"llm.model"'),
);

// Host names ship as defaults, can be replaced wholesale, and must be a clean list.
assert.deepEqual(loadPostprocessConfig(rootWith(null)).hostNames, [
  "Al",
  "Codey",
  "Jonnie",
  "Kevin",
  "Chelsea",
]);
assert.deepEqual(
  loadPostprocessConfig(rootWith({ hostNames: ["Someone"] })).hostNames,
  ["Someone"],
);
assert.throws(
  () => loadPostprocessConfig(rootWith({ hostNames: "Al" })),
  (error) => error.message.includes('"hostNames"'),
);
assert.throws(
  () => loadPostprocessConfig(rootWith({ hostNames: ["Al", ""] })),
  (error) => error.message.includes('"hostNames"'),
);
