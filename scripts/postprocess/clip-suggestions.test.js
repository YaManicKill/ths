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

// A parenthesized duration inside dialogue is speech, not a timestamp header: it must
// not split the segment or invent a bogus start time. Both header shapes still parse.
const parentheticalTranscript = `## Body
(10s) **Al:**
> We waited ages (about 3h) before anything happened at all.

**Greg:** (30s)
> That parenthesis nearly became a segment boundary once.
`;

const parentheticalSegments = parseTranscriptSegments(parentheticalTranscript);
assert.equal(parentheticalSegments.length, 2);
assert.equal(parentheticalSegments[0].startSeconds, 10);
assert.equal(
  parentheticalSegments[0].text,
  "We waited ages (about 3h) before anything happened at all.",
  "dialogue with a parenthesized duration was split or truncated",
);
assert.equal(
  parentheticalSegments[1].startSeconds,
  30,
  "speaker-first timestamp header stopped parsing",
);

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

// With a VTT available, clip boundaries snap to sentence edges instead of the flat
// trailing pad: the start pulls back to the start of its sentence, and the padded end
// finishes the sentence it lands inside rather than cutting mid-word.
const snapMd = `## Body
(10s) **Al:**
> Why would anyone actually do that, honestly?

(20s) **Greg:**
> Because it turns out the whole system is genuinely broken and weird.

(40s) **Al:**
> That means you literally cannot win the game at all, which is wild.
`;

// The 10s turn actually starts mid-sentence at 9.240; the pad target (40 + 12 = 52)
// lands inside the cue running 50.100-54.320.
const snapVtt = `WEBVTT

00:00:09.240 --> 00:00:14.760
Why would anyone actually do that, honestly?

00:00:20.120 --> 00:00:27.480
Because it turns out the whole system is genuinely broken and weird.

00:00:40.360 --> 00:00:46.900
That means you literally cannot win the game at all, which is wild.

00:00:50.100 --> 00:00:54.320
And that is the whole point of the design, when you think about it.

00:00:55.000 --> 00:00:59.000
Anyway, moving on to the next topic entirely now.
`;

const snapped = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: snapVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.ok(snapped.length > 0, "expected a snapped suggestion");
const snappedClip = snapped[0];
assert.equal(
  snappedClip.startSeconds,
  9.24,
  "start did not snap to its sentence start",
);
assert.equal(
  snappedClip.endSeconds,
  54.32,
  "end did not snap to a sentence end",
);

// The same transcript without a VTT keeps the old flat-pad behaviour.
const unsnapped = buildClipSuggestions({
  transcriptMdText: snapMd,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.ok(unsnapped.length > 0);
assert.equal(unsnapped[0].startSeconds, 10);
assert.equal(unsnapped[0].endSeconds, 52);

// When finishing the sentence would blow the duration cap, the end falls back to the
// previous sentence end instead of being rejected outright.
const capVtt = `WEBVTT

00:00:09.240 --> 00:00:14.760
Why would anyone actually do that, honestly?

00:00:20.120 --> 00:00:27.480
Because it turns out the whole system is genuinely broken and weird.

00:00:40.360 --> 00:00:46.900
That means you literally cannot win the game at all, which is wild.

00:00:50.100 --> 00:01:30.000
An enormous run-on sentence that would push the clip far beyond its cap.
`;
const capped = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: capVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.ok(capped.length > 0, "expected the capped candidate to survive");
assert.equal(
  capped[0].endSeconds,
  46.9,
  "end should fall back to the previous sentence end when finishing exceeds the cap",
);

// A clip must not open on a hesitation: leading cues that are pure filler or start with
// um/uh are skipped so the clip opens on its hook, unless that would leave it too short.
const fillerVtt = `WEBVTT

00:00:09.240 --> 00:00:14.760
Codey: Um, so you don't have a question necessarily, but you bring one.

00:00:14.760 --> 00:00:16.500
Codey: Do you want to tell the story of that?

00:00:20.120 --> 00:00:27.480
Chelsea: Because it turns out the whole system is genuinely broken and weird.

00:00:40.360 --> 00:00:46.900
Codey: That means you literally cannot win the game at all, which is wild.

00:00:50.100 --> 00:00:54.320
Chelsea: And that is the whole point of the design, when you think about it.
`;

const cleanStart = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: fillerVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.ok(cleanStart.length > 0, "expected a suggestion");
assert.equal(
  cleanStart[0].startSeconds,
  14.76,
  "clip should open on the hook cue, past the um-opening one",
);

// "Yeah, so I just asked..." is a normal sentence opener, not a hesitation - it stays.
const yeahVtt = fillerVtt.replace(
  "Codey: Um, so you don't have a question necessarily, but you bring one.",
  "Codey: Yeah, so I just asked my daughter about the whole thing there.",
);
const yeahStart = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: yeahVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.equal(
  yeahStart[0].startSeconds,
  9.24,
  "a normal opener must not be skipped",
);

// Skipping stops when the clip would drop below the minimum duration: with a 45s floor,
// moving past the first cue would leave 54.32 - 14.76 = 39.6s, so the um stays.
const guarded = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: fillerVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 45,
  maxClipDurationSeconds: 55,
});
assert.ok(guarded.length > 0, "expected the guarded suggestion to survive");
assert.equal(
  guarded[0].startSeconds,
  9.24,
  "skipping must yield to the minimum duration",
);

// At most two leading filler cues are skipped, so a long run of ums cannot walk the
// start deep into the clip.
const manyUmsVtt = `WEBVTT

00:00:09.240 --> 00:00:11.000
Codey: Um.

00:00:11.000 --> 00:00:13.000
Codey: Uh, hmm.

00:00:13.000 --> 00:00:15.000
Codey: Um, right, okay.

00:00:15.000 --> 00:00:16.500
Codey: Do you want to tell the story of that?

00:00:20.120 --> 00:00:27.480
Chelsea: Because it turns out the whole system is genuinely broken and weird.

00:00:40.360 --> 00:00:46.900
Codey: That means you literally cannot win the game at all, which is wild.

00:00:50.100 --> 00:00:54.320
Chelsea: And that is the whole point of the design, when you think about it.
`;
const cappedSkip = buildClipSuggestions({
  transcriptMdText: snapMd,
  transcriptVttText: manyUmsVtt,
  maxSuggestions: 5,
  minClipDurationSeconds: 30,
  maxClipDurationSeconds: 55,
});
assert.equal(
  cappedSkip[0].startSeconds,
  13,
  "filler skipping should stop after two cues",
);
