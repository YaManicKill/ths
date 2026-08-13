const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyTranscriptFixes,
  chunkTranscript,
  mergeChunks,
  reviewTranscript,
  reviewTranscriptCached,
  selectTranscriptFixes,
} = require("./transcript-review");

const LLM = { provider: "gemini", model: "gemini-3.5-flash", apiKey: "k" };

// No headings here: this fixture exercises the timestamp-to-chapter fallback path.
const transcriptMdText = [
  "**Codey:** (0h0m10s)",
  "Hello farmers and welcome to the show.",
  "",
  "**Chelsea:** (0h16m20s)",
  "Why do female ants not grow weight?",
  "",
  "**Codey:** (0h16m40s)",
  "Ants have wings when they are reproductively active.",
].join("\n");

const transcriptVttText = [
  "WEBVTT",
  "",
  "00:16:20.000 --> 00:16:24.000",
  "Chelsea: Why do female ants not grow weight?",
].join("\n");

const chapters = [
  { title: "Intro", startSeconds: 0 },
  { title: "Entomology Corner", startSeconds: 960 },
];

async function main() {
  // Chunks split on chapter boundaries and carry the chapter title as topic context.
  const chunks = chunkTranscript({ transcriptMdText, chapters });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chapterTitle, "Intro");
  assert.ok(chunks[0].text.includes("Hello farmers"));
  assert.equal(chunks[1].chapterTitle, "Entomology Corner");
  assert.ok(chunks[1].text.includes("grow weight"));

  // Without usable chapters everything lands in one chunk rather than being lost.
  assert.equal(
    chunkTranscript({ transcriptMdText, chapters: [{ title: "No timing" }] })
      .length,
    1,
  );

  // The real transcripts carry their own "## Chapter" headings and variable-unit
  // timestamps like "(30s)" and "(23m44s)"; headings win over timestamp mapping.
  const realFormat = [
    "## Theme Tune",
    "",
    "## Intro",
    "",
    "(30s) **Codey:**",
    "",
    "> Hello, farmers, and welcome to another episode.",
    "",
    "## Entomology Corner",
    "",
    "(16m 20s) **Chelsea:**",
    "",
    "> Why do female ants not grow weight?",
  ].join("\n");
  const realChunks = chunkTranscript({
    transcriptMdText: realFormat,
    chapters: [{ title: "Wrong Chapter", startSeconds: 0 }],
  });
  assert.deepEqual(
    realChunks.map((chunk) => chunk.chapterTitle),
    ["Intro", "Entomology Corner"],
    "heading-based chapters wrong",
  );
  assert.ok(realChunks[1].text.includes("grow weight"));

  // Small adjacent chapters merge into one request (the free tier allows few requests);
  // a merged chunk lists every chapter it spans, and oversized chapters stay separate.
  const mergedChunks = mergeChunks(
    [
      { chapterTitle: "A", startLine: 1, text: "aaa" },
      { chapterTitle: "B", startLine: 10, text: "bbb" },
      { chapterTitle: "C", startLine: 20, text: "c".repeat(50) },
    ],
    20,
  );
  assert.equal(mergedChunks.length, 2);
  assert.equal(mergedChunks[0].chapterTitle, "A / B");
  assert.equal(mergedChunks[0].startLine, 1);
  assert.ok(mergedChunks[0].text.includes("aaa"));
  assert.ok(mergedChunks[0].text.includes("bbb"));
  assert.equal(mergedChunks[1].chapterTitle, "C");

  // Findings: verbatim quotes are located in both files; hallucinated quotes (text the
  // model made up that is not in the transcript) are dropped; duplicates collapse.
  const prompts = [];
  const systems = [];
  const review = await reviewTranscript({
    transcriptMdText,
    transcriptVttText,
    chapters,
    llm: LLM,
    mergeBudgetChars: 10,
    hostNames: ["Al", "Codey"],
    complete: async ({ prompt, system }) => {
      prompts.push(prompt);
      systems.push(system);
      if (!prompt.includes("Entomology Corner")) {
        return { findings: [] };
      }
      return {
        findings: [
          {
            quote: "grow weight",
            correction: "grow wings",
            reason: "the next line says ants have wings",
            confidence: "high",
          },
          {
            quote: "grow weight",
            correction: "grow wings",
            reason: "duplicate",
            confidence: "high",
          },
          {
            quote: "this text is not in the transcript",
            correction: "anything",
            reason: "hallucinated",
            confidence: "high",
          },
        ],
      };
    },
  });

  assert.equal(review.chunksChecked, 2);
  assert.equal(prompts.length, 2, "one call per chunk");
  assert.ok(
    prompts.some((p) => p.includes("Chapters covered: Entomology Corner")),
    "chapter title missing from prompt",
  );
  assert.ok(
    systems.every((s) => s.includes("The recurring hosts are: Al, Codey")),
    "host names missing from system prompt",
  );
  assert.equal(review.findings.length, 1, "dupes and hallucinations dropped");
  const finding = review.findings[0];
  assert.equal(finding.quote, "grow weight");
  assert.equal(finding.correction, "grow wings");
  assert.equal(finding.chapterTitle, "Entomology Corner");
  assert.equal(finding.mdLine, 5, "md line number wrong");
  assert.equal(finding.vttLine, 4, "vtt line number wrong");

  // The cache returns the stored verdict for an unchanged transcript and only re-runs
  // when the content (or model) changes.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-review-"));
  let calls = 0;
  const fakeComplete = async () => {
    calls += 1;
    return { findings: [] };
  };

  const first = await reviewTranscriptCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText,
    chapters,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(first.fromCache, false);
  const callsAfterFirst = calls;
  assert.ok(callsAfterFirst > 0);

  const second = await reviewTranscriptCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText,
    chapters,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(second.fromCache, true);
  assert.equal(calls, callsAfterFirst, "cached run must not call the LLM");

  await reviewTranscriptCached({
    cacheDir,
    transcriptMdText: transcriptMdText + "\nedited",
    transcriptVttText,
    chapters,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.ok(calls > callsAfterFirst, "edited transcript must re-run");

  const callsBeforeHostChange = calls;
  await reviewTranscriptCached({
    cacheDir,
    transcriptMdText,
    transcriptVttText,
    chapters,
    llm: LLM,
    hostNames: ["Al"],
    complete: fakeComplete,
  });
  assert.ok(calls > callsBeforeHostChange, "changed host names must re-run");

  fs.rmSync(cacheDir, { recursive: true, force: true });

  // applyTranscriptFixes replaces every occurrence of a quote, reports quotes that no
  // longer match, and skips degenerate fixes rather than counting them as misses.
  const applyResult = applyTranscriptFixes(
    "the bee flew. the bee landed. all good.",
    [
      { quote: "the bee", correction: "the wasp" },
      { quote: "not present", correction: "whatever" },
      { quote: "all good", correction: "all good" },
      { quote: "", correction: "x" },
    ],
  );
  assert.equal(applyResult.text, "the wasp flew. the wasp landed. all good.");
  assert.equal(applyResult.applied.length, 1);
  assert.equal(applyResult.missed.length, 1);
  assert.equal(applyResult.missed[0].quote, "not present");

  // A correction containing its own quote-like text must not loop or reapply.
  const growResult = applyTranscriptFixes("ants grow weight fast", [
    { quote: "grow weight", correction: "grow wings and gain weight" },
  ]);
  assert.equal(growResult.text, "ants grow wings and gain weight fast");

  // Default selection is high-confidence only; an explicit list wins outright.
  const mixedReview = {
    findings: [
      { quote: "a", correction: "b", confidence: "high" },
      { quote: "c", correction: "d", confidence: "medium" },
    ],
  };
  assert.deepEqual(selectTranscriptFixes(mixedReview, undefined), [
    mixedReview.findings[0],
  ]);
  assert.deepEqual(
    selectTranscriptFixes(mixedReview, [{ quote: "x", correction: "y" }]),
    [{ quote: "x", correction: "y" }],
  );
  assert.deepEqual(selectTranscriptFixes(mixedReview, []), []);
  assert.deepEqual(selectTranscriptFixes(null, undefined), []);

  console.log("transcript-review test passed");
}

main().catch((error) => {
  console.error("transcript-review test failed:", error.message);
  process.exit(1);
});
