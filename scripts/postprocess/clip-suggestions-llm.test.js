const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCueSearchIndex,
  ensureRequiredHashtags,
  formatClipCaptionBlock,
  locateClipInCues,
  suggestClipsLlm,
  suggestClipsLlmCached,
} = require("./clip-suggestions-llm");
const { parseVttCues } = require("./vtt");

const LLM = { provider: "gemini", model: "gemini-3.6-flash", apiKey: "k" };

const transcriptVttText = [
  "WEBVTT",
  "",
  "00:00:10.000 --> 00:00:20.000",
  "Codey: So the wildest thing happened when I opened the barn door this morning.",
  "",
  "00:00:20.000 --> 00:00:35.000",
  "Codey: There was a chicken standing on the cow, and the cow did not care at all.",
  "",
  "00:00:35.000 --> 00:00:50.000",
  "Al: That is the most farming podcast sentence you have ever said, honestly.",
  "",
  "00:00:50.000 --> 00:00:55.000",
  "Al: Anyway, moving on to the news.",
].join("\n");

const transcriptMdText = [
  "## Chat",
  "",
  "(10s) **Codey:**",
  "",
  "> So the wildest thing happened when I opened the barn door this morning.",
].join("\n");

async function main() {
  // Quote location: normalised matching survives punctuation/casing differences, spans
  // cue boundaries, and searches the closing quote only after the opening one.
  const cues = parseVttCues(transcriptVttText);
  const searchIndex = buildCueSearchIndex(cues);

  const located = locateClipInCues({
    searchIndex,
    openingQuote: "The wildest thing happened, when I opened the BARN door!",
    closingQuote: "chicken standing on the cow",
  });
  assert.deepEqual(located, { startCue: 0, endCue: 1 });

  assert.equal(
    locateClipInCues({
      searchIndex,
      openingQuote: "this text is not in the episode",
      closingQuote: "chicken standing on the cow",
    }),
    null,
  );

  // Full pass: hallucinated quotes and out-of-bounds durations are dropped; overlapping
  // picks keep the higher score; the surviving clip carries timing and speaker.
  const prompts = [];
  const result = await suggestClipsLlm({
    transcriptMdText,
    transcriptVttText,
    llm: LLM,
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        clips: [
          {
            openingQuote:
              "So the wildest thing happened when I opened the barn door",
            closingQuote: "most farming podcast sentence you have ever said",
            title: "A chicken standing on a cow",
            category: "funny moment",
            reason: "Absurd farm imagery with a perfect reaction.",
            caption: "The barn had a surprise this morning 🐔🐄 #podcast #farm",
            score: 90,
          },
          // Overlaps the clip above with a lower score, so it must lose.
          {
            openingQuote: "There was a chicken standing on the cow",
            closingQuote: "most farming podcast sentence you have ever said",
            title: "Cow does not care",
            category: "funny moment",
            reason: "overlap loser",
            score: 60,
          },
          {
            openingQuote: "not words from this episode at all",
            closingQuote: "definitely hallucinated text",
            title: "Fake",
            category: "story",
            reason: "hallucinated",
            score: 99,
          },
          // Locates to a single 5-second cue, below the minimum clip length.
          {
            openingQuote: "Anyway, moving on to the news",
            closingQuote: "Anyway, moving on to the news",
            title: "Too short",
            category: "story",
            reason: "too short",
            score: 80,
          },
        ],
      };
    },
  });

  assert.equal(prompts.length, 1, "the whole episode goes in one request");
  assert.ok(
    prompts[0].includes(transcriptMdText),
    "full transcript missing from prompt",
  );

  assert.equal(result.candidatesReturned, 4);
  assert.equal(result.suggestions.length, 1);
  const clip = result.suggestions[0];
  assert.equal(clip.startSeconds, 10);
  assert.equal(clip.endSeconds, 50);
  assert.equal(clip.durationSeconds, 40);
  assert.equal(clip.summary, "A chicken standing on a cow");
  assert.equal(clip.speaker, "Codey");
  assert.equal(clip.reason, "funny moment");
  // The show hashtags are guaranteed and lead; the model's own tags follow.
  assert.equal(
    clip.caption,
    "The barn had a surprise this morning 🐔🐄 #theharvestseason #cottagecore #farminggames #podcast #farm",
  );
  assert.equal(clip.source, "llm");
  assert.ok(clip.text.includes("chicken standing on the cow"));
  assert.ok(!clip.text.includes("Codey:"), "speaker prefix left in clip text");

  // No cues means no timings to ground against, so the LLM is not called at all.
  const noVtt = await suggestClipsLlm({
    transcriptMdText,
    transcriptVttText: "",
    llm: LLM,
    complete: async () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(noVtt, { suggestions: [], candidatesReturned: 0 });

  // Hashtag guarantee: the brand trio always leads (platforms surface the first
  // tags), model tags follow deduped case-insensitively and capped at two extras.
  assert.equal(
    ensureRequiredHashtags("Great clip! #FarmingGames"),
    "Great clip! #theharvestseason #cottagecore #farminggames",
  );
  assert.equal(
    ensureRequiredHashtags("Wow #bees #honey #hive #extra"),
    "Wow #theharvestseason #cottagecore #farminggames #bees #honey",
  );
  assert.equal(
    ensureRequiredHashtags(""),
    "#theharvestseason #cottagecore #farminggames",
  );

  // The captions-file block: text, identity line, hashtags - one per line.
  assert.equal(
    formatClipCaptionBlock("Wild moment! #bees"),
    [
      "Wild moment!",
      "From The Harvest Season, a podcast about farming and cottagecore games — new episodes every Wednesday.",
      "#theharvestseason #cottagecore #farminggames #bees",
    ].join("\n"),
  );

  // Cache: unchanged transcript is a hit, edited transcript re-runs.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-clips-"));
  let calls = 0;
  const fakeComplete = async () => {
    calls += 1;
    return { clips: [] };
  };

  const first = await suggestClipsLlmCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(first.fromCache, false);
  assert.equal(calls, 1);

  const second = await suggestClipsLlmCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1, "cached run must not call the LLM");

  await suggestClipsLlmCached({
    cacheDir,
    transcriptMdText: transcriptMdText + "\nedited",
    transcriptVttText,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(calls, 2, "edited transcript must re-run");

  // Every cached timing derives from the VTT cues, so an edited VTT is a new key.
  await suggestClipsLlmCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText: transcriptVttText.replace("10.000", "11.000"),
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(calls, 3, "edited vtt must re-run");

  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log("clip-suggestions-llm test passed");
}

main().catch((error) => {
  console.error("clip-suggestions-llm test failed:", error.message);
  process.exit(1);
});
