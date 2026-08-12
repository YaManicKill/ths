const assert = require("node:assert/strict");
const { buildClipSuggestions } = require("./clip-suggestions");

const transcript = `## Body
(0s) **Al:**
> Hello and welcome to the episode.

(20s) **Greg:**
> Why did that happen?

(40s) **Al:**
> It was actually a really weird thing.

(60s) **Greg:**
> That is the most important part of the story.
`;

const suggestions = buildClipSuggestions({
  transcriptMdText: transcript,
  maxSuggestions: 5,
});
assert.ok(suggestions.length > 0, "expected at least one suggestion");
assert.ok(suggestions[0].score >= 4, "expected a high-scoring suggestion");

const longerTranscript = `## Body
(0s) **Al:**
> Why did this happen?

(8s) **Greg:**
> Because the timing was off.

(16s) **Al:**
> That made the whole thing feel strange.

(24s) **Greg:**
> And then everyone started reacting.

(32s) **Al:**
> So the lesson is simple.
`;

const longerSuggestions = buildClipSuggestions({
  transcriptMdText: longerTranscript,
  maxSuggestions: 5,
  minClipDurationSeconds: 25,
  maxSegmentsPerClip: 5,
});
assert.ok(
  longerSuggestions.some((candidate) => candidate.durationSeconds >= 25),
  "expected a longer-form clip suggestion for shorts-style pacing",
);

const focusedTranscript = `## Body
(0s) **Al:**
> So yeah I was thinking about this whole thing.

(10s) **Greg:**
> Why did it feel so strange?

(20s) **Al:**
> Because the timing was off and nobody saw it coming.
`;

const focusedSuggestions = buildClipSuggestions({
  transcriptMdText: focusedTranscript,
  maxSuggestions: 5,
  minClipDurationSeconds: 20,
  maxSegmentsPerClip: 3,
});
assert.ok(
  focusedSuggestions.length > 0,
  "expected a focused suggestion from the test transcript",
);
const bestFocusedSuggestion = focusedSuggestions[0];
assert.ok(
  !/^(so|yeah|okay|well|anyway|anyways|and|but|like|i mean|i think|probably|maybe|honestly|actually|really)\b/i.test(
    bestFocusedSuggestion.summary,
  ),
  "expected the summary to avoid generic lead-ins",
);
assert.ok(
  bestFocusedSuggestion.summary.length < 55,
  "expected the summary to stay concise and clip-like",
);

const contextTranscript = `## Body
(0s) **Al:**
> Why did the feature fail in production?

(10s) **Greg:**
> At first we thought it was the API.

(20s) **Al:**
> The real reason is that the cache was stale and hid the new values.

(30s) **Greg:**
> So the fix was to invalidate the cache on publish.
`;

const contextSuggestions = buildClipSuggestions({
  transcriptMdText: contextTranscript,
  maxSuggestions: 5,
  minClipDurationSeconds: 25,
  maxSegmentsPerClip: 5,
});
assert.ok(
  contextSuggestions.length > 0,
  "expected at least one context-rich suggestion",
);
assert.ok(
  contextSuggestions[0].durationSeconds >= 25,
  "expected a longer contextual window, not a short hook-only clip",
);
assert.ok(
  /reason|fix|cache|because|so/i.test(contextSuggestions[0].text),
  "expected top suggestion text to include explanatory context and payoff",
);

console.log("clip-suggestions test passed", suggestions[0]);
