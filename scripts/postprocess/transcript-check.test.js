const assert = require("node:assert/strict");
const { findWordMatches } = require("./transcript-check");

const transcript = `
> This was clumsy as fuck.
> Just for shits and gigs.
> That's a random ass detail.
> We should not match pass or passage.
> Also catches motherfuckers when configured with a wildcard.
`;

const matches = findWordMatches(transcript, [
  "fuck*",
  "shit*",
  "ass",
  "motherfucker*",
]);

const matchedWords = matches.map((match) => match.word);
assert.ok(matchedWords.includes("fuck*"), "expected fuck* to match fuck");
assert.ok(matchedWords.includes("shit*"), "expected shit* to match shits");
assert.ok(matchedWords.includes("ass"), "expected ass to match standalone ass");
assert.ok(
  matchedWords.includes("motherfucker*"),
  "expected motherfucker* to match motherfuckers",
);

const falsePositiveText = `
> The pass was valid.
> We read the passage carefully.
`;
const falsePositiveMatches = findWordMatches(falsePositiveText, ["ass"]);
assert.equal(
  falsePositiveMatches.length,
  0,
  "expected ass matcher to avoid pass/passage false positives",
);

console.log("transcript-check test passed", {
  matchCount: matches.length,
});
