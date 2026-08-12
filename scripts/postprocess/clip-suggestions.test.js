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

// Filler words are only stripped from the start of a segment: mid-sentence they carry
// meaning, and removing them corrupted both summaries and the burned-in clip label.
const { parseTranscriptSegments } = require("./clip-suggestions");

const fillerTranscript = `## Body
(10s) **Al:**
> I was so tired and honestly that was the best bit of the game.

(30s) **Greg:**
> So then we talked about it, and it was fine.
`;

const fillerSegments = parseTranscriptSegments(fillerTranscript);
assert.equal(
  fillerSegments[0].text,
  "I was so tired and honestly that was the best bit of the game.",
  "mid-sentence filler words must survive",
);
assert.equal(
  fillerSegments[1].text,
  "then we talked about it, and it was fine.",
  "leading filler words must still be stripped",
);
for (const segment of fillerSegments) {
  assert.ok(
    !/\s{2,}/.test(segment.text),
    `stripping left doubled spaces in ${JSON.stringify(segment.text)}`,
  );
}

// Accepted clips must not share audio. Comparing start times alone let two clips up to a
// minute long overlap by 20-30 seconds.
const denseTranscript = [
  "## Body",
  ...[
    "Why would anyone actually do that, honestly?",
    "Because it turns out the whole system is genuinely broken and weird.",
    "But what is the really surprising part of this crazy story here?",
    "Because that means you literally cannot win the game at all.",
    "How did they honestly not remember that was the worst idea?",
    "Because the reason is they never tested it properly, obviously.",
    "What if the best part is still completely hidden from you?",
    "Because in other words the whole thing was a classic mistake.",
    "Why does that actually matter so much to the people playing?",
    "Because the lesson is that nobody really checks these things.",
  ].flatMap((line, index) => [`(${index * 8}s) **Al:**`, `> ${line}`]),
].join("\n");

const denseSuggestions = buildClipSuggestions({
  transcriptMdText: denseTranscript,
  maxSuggestions: 8,
});
assert.ok(
  denseSuggestions.length > 1,
  "expected several suggestions to compare",
);

for (let i = 0; i < denseSuggestions.length; i += 1) {
  for (let j = i + 1; j < denseSuggestions.length; j += 1) {
    const a = denseSuggestions[i];
    const b = denseSuggestions[j];
    const overlap =
      Math.min(a.endSeconds, b.endSeconds) -
      Math.max(a.startSeconds, b.startSeconds);
    assert.ok(
      overlap <= 0,
      `clips ${a.timestampLabel} and ${b.timestampLabel} overlap by ${overlap}s`,
    );
  }
}
