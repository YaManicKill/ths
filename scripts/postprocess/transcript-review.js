const crypto = require("node:crypto");
const path = require("node:path");
const { completeJson } = require("./llm");
const { fileExists, readJson, writeJson } = require("./utils");

// Bump when the prompt, schema, or chunking changes so cached verdicts from the old
// request shape are not reused.
const PROMPT_VERSION = 5;
const MAX_CHUNK_CHARS = 24_000;
// Chapter chunks are merged up to this size before sending: Gemini handles large inputs
// well, and the free tier allows only a handful of requests per minute/day, so a full
// episode should cost ~3 requests rather than one per chapter.
const MERGE_BUDGET_CHARS = 80_000;
const CONCURRENCY = 2;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: {
            type: "string",
            description:
              "The wrong text, copied verbatim from the transcript including punctuation. Keep it under 15 words.",
          },
          correction: {
            type: "string",
            description:
              "Exact replacement text: substituting it for the quote in place must yield the corrected sentence.",
          },
          reason: {
            type: "string",
            description: "Why the context shows this is a mistranscription.",
          },
          confidence: { type: "string", enum: ["high", "medium"] },
        },
        required: ["quote", "correction", "reason", "confidence"],
      },
    },
  },
  required: ["findings"],
};

function buildSystemPrompt(hostNames = []) {
  const lines = [
    "You review podcast transcripts produced by automatic speech recognition and flag likely",
    "mistranscriptions: words or short phrases that the surrounding context shows are wrong,",
    "such as a homophone or near-homophone of what was actually said.",
    "",
    "Rules:",
    "- Only flag text that is CLEARLY wrong given the context. When in doubt, do not flag.",
    "- Copy the quote verbatim from the transcript, including punctuation and casing.",
    "- The correction must be exact drop-in replacement text for the quote: replacing the",
    "  quote with it, in place, must produce the corrected sentence with matching casing",
    "  and punctuation. Never offer alternatives or commentary in the correction field.",
    '- Confidence "high" means the fix is applied to the transcript automatically without',
    '  human review, so use it only when certain of the exact replacement. Use "medium"',
    "  when the text is clearly wrong but the replacement is a best guess.",
    "- Do not flag grammar, filler words, informal speech, or stylistic issues - this is a",
    "  conversational podcast and the transcript should stay faithful to what was said.",
    "- Do not flag markdown or timestamp formatting.",
    "- Game titles, character names, and farming terms come up often; a title that reads as",
    "  nonsense words may be a real game name - only flag it when context contradicts it.",
    "- An empty findings list is the expected result for most sections.",
  ];

  if (hostNames.length > 0) {
    lines.push(
      "",
      `The recurring hosts are: ${hostNames.join(", ")}. These are the only correct`,
      "spellings of their names. Any other spelling of a host's name (for example",
      '"Cody" for "Codey", or "Jonny" for "Jonnie") is a mistranscription: flag it',
      "with high confidence and correct it to the exact spelling listed here.",
    );
  }

  return lines.join("\n");
}

// Timestamps only carry the units they need, sometimes space-separated: "(30s)",
// "(23m44s)", "(39m 1s)", "(1h 2m 3s)".
function parseMdTimestampSeconds(line) {
  const match = /\(([0-9hms ]+)\)/.exec(line);
  if (!match || !/\d/.test(match[1])) {
    return null;
  }

  const tokenPattern = /(\d+)([hms])/g;
  let total = 0;
  let found = false;
  let token;
  while ((token = tokenPattern.exec(match[1])) !== null) {
    found = true;
    const amount = Number(token[1]);
    total +=
      token[2] === "h"
        ? amount * 3600
        : token[2] === "m"
          ? amount * 60
          : amount;
  }
  return found ? total : null;
}

// One chunk per chapter (split when oversized), so each request carries the chapter
// title as topic context - which is what catches game-name mistranscriptions. The
// transcript's own "## Chapter" headings are the primary signal; timestamp-to-chapter
// mapping is the fallback for transcripts without headings.
function chunkTranscript({ transcriptMdText, chapters = [] }) {
  const lines = String(transcriptMdText || "").split("\n");
  const timedChapters = (chapters || []).filter(
    (chapter) => typeof chapter.startSeconds === "number",
  );

  const chunks = [];
  let current = null;
  // The first chunk already carries chapter 0's title, so the index starts there —
  // otherwise the first timestamp inside chapter 0 would split off an empty-headed chunk.
  let chapterIndex = timedChapters.length > 0 ? 0 : -1;
  let sawHeading = false;

  const startChunk = (chapterTitle, startLine) => {
    current = { chapterTitle, startLine, lines: [] };
    chunks.push(current);
  };

  // A chunk holding no speech yet (only blanks or headings, like the content-free
  // "## Theme Tune" section) is renamed in place instead of being split off empty.
  const renameOrStartChunk = (chapterTitle, startLine) => {
    const hasSpeech = current.lines.some(
      (line) => line.trim() !== "" && !/^##\s/.test(line),
    );
    if (hasSpeech) {
      startChunk(chapterTitle, startLine);
    } else {
      current.chapterTitle = chapterTitle;
    }
  };

  startChunk(timedChapters[0]?.title || null, 1);

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+)$/.exec(lines[index]);
    const seconds = heading ? null : parseMdTimestampSeconds(lines[index]);

    if (heading) {
      sawHeading = true;
      renameOrStartChunk(heading[1].trim(), index + 1);
    } else if (seconds !== null && !sawHeading) {
      let nextChapterIndex = chapterIndex;
      while (
        nextChapterIndex + 1 < timedChapters.length &&
        timedChapters[nextChapterIndex + 1].startSeconds <= seconds
      ) {
        nextChapterIndex += 1;
      }
      if (nextChapterIndex !== chapterIndex) {
        chapterIndex = nextChapterIndex;
        renameOrStartChunk(timedChapters[chapterIndex].title, index + 1);
      }
    }

    const chunkChars = current.lines.join("\n").length;
    if (chunkChars >= MAX_CHUNK_CHARS && (seconds !== null || heading)) {
      startChunk(current.chapterTitle, index + 1);
    }

    current.lines.push(lines[index]);
  }

  return chunks
    .map((chunk) => ({
      chapterTitle: chunk.chapterTitle,
      startLine: chunk.startLine,
      text: chunk.lines.join("\n"),
    }))
    .filter((chunk) => chunk.text.trim().length > 0);
}

// Adjacent chapter chunks are coalesced up to the budget; a merged chunk lists every
// chapter it spans so the prompt still carries the topic context.
function mergeChunks(chunks, mergeBudgetChars) {
  const merged = [];

  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.text.length + chunk.text.length + 1 <= mergeBudgetChars) {
      last.text += `\n${chunk.text}`;
      if (chunk.chapterTitle && !last.titles.includes(chunk.chapterTitle)) {
        last.titles.push(chunk.chapterTitle);
      }
    } else {
      merged.push({
        text: chunk.text,
        startLine: chunk.startLine,
        titles: chunk.chapterTitle ? [chunk.chapterTitle] : [],
      });
    }
  }

  return merged.map((chunk) => ({
    chapterTitle: chunk.titles.join(" / ") || null,
    startLine: chunk.startLine,
    text: chunk.text,
  }));
}

function lineNumberOf(haystack, needle) {
  const index = haystack.indexOf(needle);
  if (index === -1) {
    return null;
  }
  return haystack.slice(0, index).split("\n").length;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function reviewTranscript({
  transcriptMdText,
  transcriptVttText,
  chapters,
  llm,
  hostNames = [],
  complete = completeJson,
  mergeBudgetChars = MERGE_BUDGET_CHARS,
}) {
  const systemPrompt = buildSystemPrompt(hostNames);
  const chunks = mergeChunks(
    chunkTranscript({ transcriptMdText, chapters }),
    mergeBudgetChars,
  );

  const chunkFindings = await mapWithConcurrency(
    chunks,
    CONCURRENCY,
    async (chunk) => {
      const prompt = [
        "Podcast: The Harvest Season, a conversational podcast about farming and",
        "life-sim video games.",
        chunk.chapterTitle ? `Chapters covered: ${chunk.chapterTitle}` : null,
        "",
        "Transcript section:",
        "---",
        chunk.text,
        "---",
      ]
        .filter((line) => line !== null)
        .join("\n");

      const result = await complete({
        llm,
        system: systemPrompt,
        prompt,
        schema: REVIEW_SCHEMA,
      });
      return { chunk, findings: result?.findings || [] };
    },
  );

  const findings = [];
  const seenQuotes = new Set();

  for (const { chunk, findings: rawFindings } of chunkFindings) {
    for (const raw of rawFindings) {
      const quote = String(raw.quote || "").trim();
      if (!quote || seenQuotes.has(quote)) {
        continue;
      }
      // The model must quote verbatim; anything not present in the transcript is a
      // hallucination and gets dropped rather than shown as a bogus warning.
      if (!transcriptMdText.includes(quote)) {
        continue;
      }
      seenQuotes.add(quote);

      findings.push({
        quote,
        correction: String(raw.correction || "").trim(),
        reason: String(raw.reason || "").trim(),
        confidence: raw.confidence === "high" ? "high" : "medium",
        chapterTitle: chunk.chapterTitle,
        mdLine: lineNumberOf(transcriptMdText, quote),
        vttLine: transcriptVttText
          ? lineNumberOf(transcriptVttText, quote)
          : null,
      });
    }
  }

  findings.sort((a, b) => (a.mdLine || 0) - (b.mdLine || 0));
  return { findings, chunksChecked: chunks.length };
}

// High-confidence findings apply on their own; an explicit list (the UI's selection of
// high plus user-ticked medium findings) takes precedence when provided.
function selectTranscriptFixes(review, explicitFixes) {
  if (Array.isArray(explicitFixes)) {
    return explicitFixes;
  }
  return (review?.findings || []).filter(
    (finding) => finding.confidence === "high",
  );
}

// Fixes are plain string replacements of the verbatim quote. A quote that no longer
// appears (edited by hand since discovery, or split across VTT cue boundaries) is
// reported as missed rather than fuzzily matched.
function applyTranscriptFixes(text, fixes) {
  let result = String(text || "");
  const applied = [];
  const missed = [];

  for (const fix of fixes || []) {
    const quote = String(fix.quote || "");
    const correction = String(fix.correction || "");
    if (!quote || !correction || quote === correction) {
      continue;
    }
    if (!result.includes(quote)) {
      missed.push(fix);
      continue;
    }
    result = result.split(quote).join(correction);
    applied.push(fix);
  }

  return { text: result, applied, missed };
}

// Discovery re-runs on every input change and again before each run, so verdicts are
// cached by transcript content + model; only an edited transcript costs another pass.
async function reviewTranscriptCached({ cacheDir, ...options }) {
  const cacheKey = crypto
    .createHash("sha1")
    .update(
      `${PROMPT_VERSION}:${options.llm.provider}:${options.llm.model}:${(options.hostNames || []).join(",")}:${options.transcriptMdText}`,
    )
    .digest("hex");
  const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  if (cachePath && fileExists(cachePath)) {
    const cached = readJson(cachePath, false);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await reviewTranscript(options);
  if (cachePath) {
    writeJson(cachePath, result);
  }
  return { ...result, fromCache: false };
}

module.exports = {
  applyTranscriptFixes,
  chunkTranscript,
  mergeChunks,
  reviewTranscript,
  reviewTranscriptCached,
  selectTranscriptFixes,
};
