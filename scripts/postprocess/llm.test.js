const assert = require("node:assert/strict");
const { GEMINI_ENDPOINT, completeJson, resolveLlm } = require("./llm");

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const LLM = { provider: "gemini", model: "gemini-3.5-flash", apiKey: "k-123" };
const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

async function main() {
  // Key resolution: config key wins, env key fills in, neither means disabled.
  delete process.env.GEMINI_API_KEY;
  assert.equal(resolveLlm({ llm: { ...LLM, apiKey: null } }), null);
  assert.equal(resolveLlm({}), null);
  assert.equal(resolveLlm({ llm: LLM })?.apiKey, "k-123");
  process.env.GEMINI_API_KEY = "env-key";
  assert.equal(
    resolveLlm({ llm: { ...LLM, apiKey: null } })?.apiKey,
    "env-key",
  );
  delete process.env.GEMINI_API_KEY;

  // The request carries the model, system instruction, prompt, schema and key header.
  const requests = [];
  const result = await completeJson({
    llm: LLM,
    system: "sys",
    prompt: "do the thing",
    schema: SCHEMA,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return fakeResponse(200, { output_text: '{"ok": true}' });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests[0].url, GEMINI_ENDPOINT);
  assert.equal(requests[0].options.headers["x-goog-api-key"], "k-123");
  const sent = JSON.parse(requests[0].options.body);
  assert.equal(sent.model, "gemini-3.5-flash");
  assert.equal(sent.system_instruction, "sys");
  assert.equal(sent.input, "do the thing");
  assert.deepEqual(sent.response_format.schema, SCHEMA);
  assert.equal(sent.response_format.mime_type, "application/json");

  // The raw REST response has no output_text: the text lives in the model_output step,
  // after opaque "thought" steps (shape confirmed against the live API).
  const fromSteps = await completeJson({
    llm: LLM,
    system: "s",
    prompt: "p",
    schema: SCHEMA,
    fetchImpl: async () =>
      fakeResponse(200, {
        id: "v1_abc",
        status: "completed",
        steps: [
          { type: "thought", signature: "opaque" },
          {
            type: "model_output",
            content: [{ type: "text", text: '{"ok": false}' }],
          },
        ],
      }),
  });
  assert.deepEqual(fromSteps, { ok: false });

  // API errors surface with the status and the provider's message.
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      fetchImpl: async () =>
        fakeResponse(400, { error: { message: "API key not valid" } }),
    }),
    /Gemini request failed \(400\): API key not valid/,
  );

  // Model output that is not valid JSON is an error, not a silent empty result.
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      fetchImpl: async () => fakeResponse(200, { output_text: "not json {" }),
    }),
    /not valid JSON/,
  );

  // Rate limits are retried once; a second failure surfaces.
  let attempts = 0;
  const retried = await completeJson({
    llm: LLM,
    system: "s",
    prompt: "p",
    schema: SCHEMA,
    retryDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? fakeResponse(429, { error: { message: "rate limited" } })
        : fakeResponse(200, { output_text: '{"ok": true}' });
    },
  });
  assert.equal(attempts, 2, "429 should be retried once");
  assert.deepEqual(retried, { ok: true });

  // A 429 carrying Google's "retry in Xs" hint waits that long (bounded), and gives up
  // after the attempt cap rather than retrying forever.
  let hintedAttempts = 0;
  const hinted = await completeJson({
    llm: LLM,
    system: "s",
    prompt: "p",
    schema: SCHEMA,
    retryDelayMs: 1,
    fetchImpl: async () => {
      hintedAttempts += 1;
      return hintedAttempts === 1
        ? fakeResponse(429, {
            error: { message: "Quota exceeded. Please retry in 0.001s." },
          })
        : fakeResponse(200, { output_text: '{"ok": true}' });
    },
  });
  assert.equal(hintedAttempts, 2);
  assert.deepEqual(hinted, { ok: true });

  let exhaustedAttempts = 0;
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      retryDelayMs: 1,
      fetchImpl: async () => {
        exhaustedAttempts += 1;
        return fakeResponse(429, { error: { message: "rate limited" } });
      },
    }),
    /429/,
  );
  assert.equal(exhaustedAttempts, 4, "should stop after the attempt cap");

  // A hint beyond the per-wait cap means daily quota - retrying cannot succeed within
  // this run, so it must fail immediately instead of stalling through capped waits.
  let dailyQuotaAttempts = 0;
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      retryDelayMs: 1,
      fetchImpl: async () => {
        dailyQuotaAttempts += 1;
        return fakeResponse(429, {
          error: { message: "Quota exceeded. Please retry in 57600s." },
        });
      },
    }),
    /429/,
  );
  assert.equal(dailyQuotaAttempts, 1, "huge retry hints must fail fast");

  // The cumulative wait budget stops retry sequences whose individual hints look
  // per-minute but never recover (daily quota disguised with a small hint).
  let budgetAttempts = 0;
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      retryDelayMs: 1,
      maxTotalRetryWaitMs: 1500,
      fetchImpl: async () => {
        budgetAttempts += 1;
        return fakeResponse(429, {
          error: { message: "Quota exceeded. Please retry in 0.001s." },
        });
      },
    }),
    /429/,
  );
  // Each hinted wait is ~1s, so a 1.5s budget allows exactly one retry.
  assert.equal(budgetAttempts, 2, "total wait budget was not enforced");

  // Timeouts are transient: they retry like a 5xx instead of surfacing immediately.
  let timeoutAttempts = 0;
  const afterTimeout = await completeJson({
    llm: LLM,
    system: "s",
    prompt: "p",
    schema: SCHEMA,
    retryDelayMs: 1,
    fetchImpl: async () => {
      timeoutAttempts += 1;
      if (timeoutAttempts === 1) {
        const abort = new Error("This operation was aborted");
        abort.name = "AbortError";
        throw abort;
      }
      return fakeResponse(200, { output_text: '{"ok": true}' });
    },
  });
  assert.equal(timeoutAttempts, 2, "timeout should be retried");
  assert.deepEqual(afterTimeout, { ok: true });

  // A bad key (401/403) must not be retried.
  let badKeyAttempts = 0;
  await assert.rejects(
    completeJson({
      llm: LLM,
      system: "s",
      prompt: "p",
      schema: SCHEMA,
      retryDelayMs: 1,
      fetchImpl: async () => {
        badKeyAttempts += 1;
        return fakeResponse(403, { error: { message: "forbidden" } });
      },
    }),
    /403/,
  );
  assert.equal(badKeyAttempts, 1, "auth errors must not be retried");

  await assert.rejects(
    completeJson({ llm: { ...LLM, provider: "openai" }, schema: SCHEMA }),
    /Unsupported LLM provider/,
  );

  console.log("llm test passed");
}

main().catch((error) => {
  console.error("llm test failed:", error.message);
  process.exit(1);
});
