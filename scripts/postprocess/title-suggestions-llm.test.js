const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  suggestTitlesLlm,
  suggestTitlesLlmCached,
} = require("./title-suggestions-llm");

const LLM = { provider: "gemini", model: "gemini-3.6-flash", apiKey: "k" };
const transcriptMdText = "## Chat\n\n**Al:** Bubble those watermelons!";

async function main() {
  const result = await suggestTitlesLlm({
    transcriptMdText,
    llm: LLM,
    complete: async ({ prompt, system }) => {
      assert.ok(
        prompt.includes(transcriptMdText),
        "full transcript missing from prompt",
      );
      assert.ok(
        system.includes("Boots and Snoots"),
        "past titles missing from the style guide",
      );
      return {
        titles: [
          { title: "  Whole Watermelons  ", reason: "The bubbling bit." },
          { title: "", reason: "empty titles are dropped" },
          ...Array.from({ length: 12 }, (_, i) => ({
            title: `Filler ${i}`,
            reason: "cap check",
          })),
        ],
      };
    },
  });
  assert.equal(result.titles[0].title, "Whole Watermelons");
  assert.equal(result.titles[0].reason, "The bubbling bit.");
  assert.equal(result.titles.length, 8, "suggestions must cap at 8");

  // Cache: unchanged transcript is a hit, edited transcript re-runs.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ths-titles-"));
  let calls = 0;
  const fakeComplete = async () => {
    calls += 1;
    return { titles: [{ title: "A Title", reason: "r" }] };
  };

  const first = await suggestTitlesLlmCached({
    cacheDir,
    transcriptMdText,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(first.fromCache, false);
  const second = await suggestTitlesLlmCached({
    cacheDir,
    transcriptMdText,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1, "cached run must not call the LLM");
  await suggestTitlesLlmCached({
    cacheDir,
    transcriptMdText: `${transcriptMdText} edited`,
    llm: LLM,
    complete: fakeComplete,
  });
  assert.equal(calls, 2, "edited transcript must re-run");

  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log("title-suggestions-llm test passed");
}

main().catch((error) => {
  console.error("title-suggestions-llm test failed:", error.message);
  process.exit(1);
});
