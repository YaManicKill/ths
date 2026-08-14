const crypto = require("node:crypto");
const path = require("node:path");
const { completeJson } = require("./llm");
const { formatSecondsToHhmmss } = require("./parsers");
const { parseVttCues } = require("./vtt");
const { fileExists, readJson, writeJson } = require("./utils");

// Bump when the prompt or schema changes so cached picks from the old request shape are
// not reused. Versioned separately from the transcript check: the two features evolve
// independently and a prompt tweak in one must not invalidate the other's cache.
const CLIP_PROMPT_VERSION = 3;
const MAX_LLM_SUGGESTIONS = 10;
// Validity bounds for a located clip, looser than the prompt's stated target so a
// slightly long-but-good pick survives; anything outside is a bad quote match.
const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 90;

const CLIP_CATEGORIES = ["funny moment", "hot take", "story", "wholesome"];

// Every posted clip carries the show's hashtags. The prompt asks for them so the model
// weaves them in naturally, and ensureRequiredHashtags guarantees them even when it
// forgets.
const REQUIRED_CLIP_HASHTAGS = [
  "#cottagecore",
  "#farminggames",
  "#theharvestseason",
];

function ensureRequiredHashtags(caption) {
  const base = String(caption || "").trim();
  const missing = REQUIRED_CLIP_HASHTAGS.filter(
    (tag) => !new RegExp(tag, "i").test(base),
  );
  if (missing.length === 0) {
    return base;
  }
  return [base, ...missing].filter(Boolean).join(" ");
}

const CLIP_SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          openingQuote: {
            type: "string",
            description:
              "The first words spoken in the clip, copied verbatim from the transcript. At least 8 words. No speaker names or timestamps.",
          },
          closingQuote: {
            type: "string",
            description:
              "The last words spoken in the clip, copied verbatim from the transcript. At least 8 words. No speaker names or timestamps.",
          },
          title: {
            type: "string",
            description: "A short, punchy hook for the clip.",
          },
          category: { type: "string", enum: CLIP_CATEGORIES },
          reason: {
            type: "string",
            description: "One sentence on why this moment works as a clip.",
          },
          caption: {
            type: "string",
            description:
              "A ready-to-post social media caption: one or two energetic sentences that tease the moment without spoiling the payoff, ending with hashtags that always include #cottagecore #farminggames #theharvestseason plus one or two clip-specific ones.",
          },
          score: {
            type: "number",
            description: "How strong the clip is, 0 (weak) to 100 (must-post).",
          },
        },
        required: [
          "openingQuote",
          "closingQuote",
          "title",
          "category",
          "reason",
          "caption",
          "score",
        ],
      },
    },
  },
  required: ["clips"],
};

const SYSTEM_PROMPT = [
  "You pick short, shareable social-media clips from a podcast transcript.",
  "",
  "Timestamps like (23m44s) mark speaker turns; chapter headings start with ##.",
  "",
  "Rules:",
  `- Return up to ${MAX_LLM_SUGGESTIONS} of the most engaging self-contained moments.`,
  "- Each clip must make sense to someone who has not heard the episode: it needs its",
  "  own hook and payoff, and must not open or end mid-thought.",
  "- Target 25 to 60 seconds of speech; use the timestamps to estimate length.",
  "- Copy openingQuote and closingQuote verbatim from the transcript, at least 8 words",
  "  each, without speaker names or timestamps. Clips that cannot be located from their",
  "  quotes are discarded, so verbatim accuracy matters more than anything else.",
  "- Prefer moments with energy: laughter, disagreement, surprising facts, strong",
  "  opinions, good storytelling beats. Avoid housekeeping, greetings, ad reads and",
  "  outro/credits talk.",
  "- The caption is pasted as-is when posting the clip: one or two energetic sentences",
  "  that tease the moment without spoiling the payoff, ending with hashtags - always",
  `  ${REQUIRED_CLIP_HASHTAGS.join(" ")}, plus one or two specific to the clip.`,
  "- Clips must not overlap each other.",
].join("\n");

// Quote matching is done on aggressively normalised text so punctuation, casing and
// small formatting differences between transcript.md (what the model reads) and
// transcript.vtt (where the timings live) do not break the lookup.
function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cue text carries a "Speaker: " prefix from the transcriber; quotes never include it.
function cueSpeechText(text) {
  return String(text || "").replace(/^[^:\n]{1,30}:\s*/, "");
}

function buildCueSearchIndex(cues) {
  let concat = "";
  const spans = [];

  cues.forEach((cue, index) => {
    const normalized = normalizeForMatch(cueSpeechText(cue.text));
    if (!normalized) {
      return;
    }
    if (concat) {
      concat += " ";
    }
    spans.push({
      start: concat.length,
      end: concat.length + normalized.length,
      index,
    });
    concat += normalized;
  });

  return { concat, spans };
}

function cueIndexAtOffset(spans, offset) {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) {
      return span.index;
    }
  }
  return -1;
}

// Maps a clip's opening/closing quotes onto cue indices. The closing quote is searched
// from the opening match onward, so a phrase that also occurs earlier in the episode
// cannot pull the clip end backwards.
function locateClipInCues({ searchIndex, openingQuote, closingQuote }) {
  const opening = normalizeForMatch(openingQuote);
  const closing = normalizeForMatch(closingQuote);
  if (!opening || !closing) {
    return null;
  }

  const startOffset = searchIndex.concat.indexOf(opening);
  if (startOffset === -1) {
    return null;
  }
  const closingOffset = searchIndex.concat.indexOf(closing, startOffset);
  if (closingOffset === -1) {
    return null;
  }

  const startCue = cueIndexAtOffset(searchIndex.spans, startOffset);
  const endCue = cueIndexAtOffset(
    searchIndex.spans,
    closingOffset + closing.length - 1,
  );
  if (startCue === -1 || endCue === -1 || endCue < startCue) {
    return null;
  }
  return { startCue, endCue };
}

async function suggestClipsLlm({
  transcriptMdText,
  transcriptVttText,
  llm,
  complete = completeJson,
  maxSuggestions = MAX_LLM_SUGGESTIONS,
}) {
  const cues = parseVttCues(transcriptVttText || "");
  if (cues.length === 0) {
    return { suggestions: [], candidatesReturned: 0 };
  }

  // The whole episode goes in one request: clip selection is a global ranking task, and
  // a full transcript is well within the model's context window.
  const prompt = [
    "Podcast: The Harvest Season, a conversational podcast about farming and",
    "life-sim video games.",
    "",
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
    schema: CLIP_SCHEMA,
    timeoutMs: 300_000,
  });
  const rawClips = Array.isArray(result?.clips) ? result.clips : [];

  const searchIndex = buildCueSearchIndex(cues);
  const round3 = (value) => Math.round(value * 1000) / 1000;
  const candidates = [];

  for (const raw of rawClips) {
    // A clip whose quotes cannot be found in the cue text is a hallucination (or an
    // md/vtt divergence); either way there is no trustworthy timing for it.
    const located = locateClipInCues({
      searchIndex,
      openingQuote: raw.openingQuote,
      closingQuote: raw.closingQuote,
    });
    if (!located) {
      continue;
    }

    const startSeconds = cues[located.startCue].startSeconds;
    const endSeconds = cues[located.endCue].endSeconds;
    const durationSeconds = endSeconds - startSeconds;
    if (
      durationSeconds < MIN_CLIP_SECONDS ||
      durationSeconds > MAX_CLIP_SECONDS
    ) {
      continue;
    }

    const title = String(raw.title || "").trim() || "Clip";
    const speakerMatch = /^([^:\n]{1,30}):/.exec(cues[located.startCue].text);
    const score = Math.max(0, Math.min(100, Number(raw.score) || 0));

    candidates.push({
      startSeconds: round3(startSeconds),
      endSeconds: round3(endSeconds),
      durationSeconds: round3(durationSeconds),
      score,
      text: cues
        .slice(located.startCue, located.endCue + 1)
        .map((cue) => cueSpeechText(cue.text))
        .join(" "),
      summary: title,
      title,
      speaker: speakerMatch ? speakerMatch[1].trim() : null,
      reason: CLIP_CATEGORIES.includes(raw.category) ? raw.category : "moment",
      llmReason: String(raw.reason || "").trim(),
      caption: ensureRequiredHashtags(raw.caption),
      timestampLabel: `${formatSecondsToHhmmss(startSeconds)}-${formatSecondsToHhmmss(endSeconds)}`,
      source: "llm",
    });
  }

  const accepted = [];
  candidates
    .sort((left, right) => right.score - left.score)
    .forEach((candidate) => {
      const overlaps = accepted.some(
        (existing) =>
          candidate.startSeconds < existing.endSeconds &&
          existing.startSeconds < candidate.endSeconds,
      );
      if (!overlaps) {
        accepted.push(candidate);
      }
    });

  return {
    suggestions: accepted.slice(0, maxSuggestions),
    candidatesReturned: rawClips.length,
  };
}

// Same shape as the transcript check's cache: keyed by everything that shapes the
// output - the VTT is in the key because every cached timing is derived from its cues,
// so an edited VTT must not serve stale cut points.
async function suggestClipsLlmCached({ cacheDir, ...options }) {
  const md = String(options.transcriptMdText || "");
  const vtt = String(options.transcriptVttText || "");
  const cacheKey = crypto
    .createHash("sha1")
    .update(
      `${CLIP_PROMPT_VERSION}:${options.llm.provider}:${options.llm.model}:${options.maxSuggestions || MAX_LLM_SUGGESTIONS}:${md.length}:${md}:${vtt.length}:${vtt}`,
    )
    .digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  if (cachePath && fileExists(cachePath)) {
    const cached = readJson(cachePath, false);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await suggestClipsLlm(options);
  if (cachePath) {
    writeJson(cachePath, result);
  }
  return { ...result, fromCache: false };
}

module.exports = {
  buildCueSearchIndex,
  ensureRequiredHashtags,
  locateClipInCues,
  suggestClipsLlm,
  suggestClipsLlmCached,
};
