const crypto = require("node:crypto");
const path = require("node:path");
const { completeJson } = require("./llm");
const { fileExists, readJson, writeJson } = require("./utils");

// Bump when the prompt or schema changes so cached suggestions are not reused.
const TITLE_PROMPT_VERSION = 1;
const MAX_TITLE_SUGGESTIONS = 8;

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A candidate episode title: a short, funny phrase lifted from the episode itself. Title Case, 2-6 words, no episode numbers.",
          },
          reason: {
            type: "string",
            description:
              "One short sentence pointing at the moment or quote the title comes from.",
          },
        },
        required: ["title", "reason"],
      },
    },
  },
  required: ["titles"],
};

const SYSTEM_PROMPT = [
  "You suggest episode titles for The Harvest Season, a conversational podcast about",
  "farming and cottagecore games.",
  "",
  "The show's titles are short absurd phrases, in-jokes or odd quotes lifted straight",
  'from the episode - past examples: "Bubble Those Watermelons", "Boots and Snoots",',
  '"Cadbury\'s Slightly Larger Than Normal Buttons".',
  "",
  "Rules:",
  `- Return up to ${MAX_TITLE_SUGGESTIONS} candidates, best first.`,
  "- Each title comes from a genuinely memorable or funny moment in the transcript -",
  "  a turn of phrase, a mishearing, a running joke - not a summary of the topics.",
  "- Title Case, roughly 2-6 words. No episode numbers, no 'THS', no punctuation",
  "  beyond what the phrase itself needs.",
  "- The reason names the moment it comes from, so the host can judge without",
  "  re-reading the transcript.",
].join("\n");

async function suggestTitlesLlm({
  transcriptMdText,
  llm,
  complete = completeJson,
}) {
  const prompt = [
    "Full episode transcript:",
    "---",
    transcriptMdText,
    "---",
  ].join("\n");

  // A whole episode in one request takes the model well past the default timeout.
  const result = await complete({
    llm,
    system: SYSTEM_PROMPT,
    prompt,
    schema: TITLE_SCHEMA,
    timeoutMs: 300_000,
  });

  const titles = (Array.isArray(result?.titles) ? result.titles : [])
    .map((candidate) => ({
      title: String(candidate?.title || "").trim(),
      reason: String(candidate?.reason || "").trim(),
    }))
    .filter((candidate) => candidate.title)
    .slice(0, MAX_TITLE_SUGGESTIONS);

  return { titles };
}

async function suggestTitlesLlmCached({ cacheDir, ...options }) {
  const md = String(options.transcriptMdText || "");
  const cacheKey = crypto
    .createHash("sha1")
    .update(
      `${TITLE_PROMPT_VERSION}:${options.llm.provider}:${options.llm.model}:${md.length}:${md}`,
    )
    .digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  if (cachePath && fileExists(cachePath)) {
    const cached = readJson(cachePath, false);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await suggestTitlesLlm(options);
  if (cachePath) {
    writeJson(cachePath, result);
  }
  return { ...result, fromCache: false };
}

module.exports = {
  suggestTitlesLlm,
  suggestTitlesLlmCached,
};
