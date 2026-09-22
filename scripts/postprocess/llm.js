// Thin LLM client: the whole surface either LLM feature needs is "prompt in, schema-valid
// JSON out". Providers plug in behind completeJson; only Gemini is implemented so far.

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const REQUEST_TIMEOUT_MS = 60_000;

// The API key comes from config (normally postprocess.config.local.json, which is
// gitignored — the main config is committed to a public repo) or the environment.
function resolveLlm(config) {
  const llm = config?.llm;
  if (!llm) {
    return null;
  }

  const apiKey = llm.apiKey || process.env.GEMINI_API_KEY || null;
  if (!apiKey) {
    return null;
  }

  return {
    provider: llm.provider,
    model: llm.model,
    fallbackModels: resolveFallbackModels(llm),
    apiKey,
  };
}

// Tried in order after the primary. A config still using the older single
// "fallbackModel" key keeps its meaning exactly (one fallback, or null for none) and
// takes precedence over the default list. Duplicates and the primary itself are
// dropped so the chain never revisits a model that is already rate limited.
function resolveFallbackModels(llm) {
  const legacy = llm.fallbackModel !== undefined;
  const listed = legacy
    ? llm.fallbackModel
      ? [llm.fallbackModel]
      : []
    : Array.isArray(llm.fallbackModels)
      ? llm.fallbackModels
      : [];
  const chain = [];
  for (const model of listed) {
    if (typeof model === "string" && model && model !== llm.model && !chain.includes(model)) {
      chain.push(model);
    }
  }
  return chain;
}

// The REST response carries the text in a steps[].type === "model_output" entry
// (alongside opaque "thought" steps); output_text is an SDK-side convenience that the
// raw API does not return, kept here as a fallback in case it appears.
function extractGeminiText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }

  for (const step of payload.steps || []) {
    if (step.type !== "model_output" && step.type !== "model_response") {
      continue;
    }
    for (const part of step.content || []) {
      if (part.type === "text" && part.text) {
        return part.text;
      }
    }
  }

  return null;
}

async function geminiCompleteJson({
  llm,
  system,
  prompt,
  schema,
  timeoutMs,
  fetchImpl,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let bodyText;
  try {
    response = await fetchImpl(GEMINI_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-goog-api-key": llm.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: llm.model,
        system_instruction: system,
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema,
        },
      }),
    });
    // Read the body under the same timer: a response whose body stalls would
    // otherwise hang here forever, since the timeout only covered the handshake.
    bodyText = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Gemini request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let message = bodyText.slice(0, 300);
    try {
      message = JSON.parse(bodyText).error?.message || message;
    } catch {
      // Non-JSON error body; keep the raw excerpt.
    }
    throw new Error(`Gemini request failed (${response.status}): ${message}`);
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Gemini returned a non-JSON response body: ${bodyText.slice(0, 200)}`,
    );
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error(
      `Gemini response contained no output text: ${bodyText.slice(0, 200)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini output was not valid JSON: ${text.slice(0, 200)}`);
  }
}

// Rate limits, transient server errors and timeouts are retried with patience: the
// free Gemini tier allows only a handful of requests per minute, and its 429s name the
// exact wait ("Please retry in 36.4s"), so honoring that hint is what makes a
// multi-chunk review complete instead of failing. Auth and request-shape errors
// surface immediately, and so does a hint beyond the per-wait cap - that means quota
// that will not recover within this run (daily limits hint hours), where retrying
// would only stall the pipeline. The total-wait budget bounds the pathological case
// the caps cannot see: a daily-quota 429 whose hint looks like a per-minute one.
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 70_000;
const MAX_TOTAL_RETRY_WAIT_MS = 150_000;

function retryDelayFromError(error, fallbackMs, attempt) {
  const retryable =
    /\((429|500|502|503|529)\)/.test(error.message) ||
    /timed out after \d+ms/.test(error.message);
  if (!retryable) {
    return null;
  }
  const hint = /retry in (\d+(?:\.\d+)?)s/i.exec(error.message);
  if (hint) {
    const hintMs = Number(hint[1]) * 1000 + 1000;
    return hintMs > MAX_RETRY_WAIT_MS ? null : hintMs;
  }
  return Math.min(fallbackMs * attempt, MAX_RETRY_WAIT_MS);
}

async function completeJson({
  llm,
  system,
  prompt,
  schema,
  // Names the request in retry/failover log lines, so a stuck feature is
  // identifiable from the terminal.
  label = "LLM",
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelayMs = 2000,
  maxTotalRetryWaitMs = MAX_TOTAL_RETRY_WAIT_MS,
  fetchImpl = fetch,
}) {
  if (llm.provider !== "gemini") {
    throw new Error(`Unsupported LLM provider: ${llm.provider}`);
  }

  // completeJson is also called with hand-built llm objects (tests, callers that
  // bypass resolveLlm), so the chain is normalised here too.
  const models = [llm.model, ...resolveFallbackModels(llm)];
  let modelIndex = 0;
  let model = models[0];
  let totalWaitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await geminiCompleteJson({
        llm: { ...llm, model },
        system,
        prompt,
        schema,
        timeoutMs,
        fetchImpl,
      });
    } catch (error) {
      const delay = retryDelayFromError(error, retryDelayMs, attempt);
      const quotaError = /\(429\)/.test(error.message);
      const fallbackAvailable = modelIndex < models.length - 1;
      if (
        delay === null ||
        attempt >= MAX_ATTEMPTS ||
        totalWaitedMs + delay > maxTotalRetryWaitMs ||
        // Free-tier quotas are per model, so with a fresh bucket one switch away,
        // sitting out the primary's full retry ladder is pure waiting: one retry
        // covers a transient blip, then the fallback takes over.
        (quotaError && fallbackAvailable && attempt >= 2)
      ) {
        if (quotaError && fallbackAvailable) {
          modelIndex += 1;
          console.error(
            `${label}: ${model} is rate limited - falling back to ${models[modelIndex]} (${modelIndex} of ${models.length - 1})`,
          );
          model = models[modelIndex];
          totalWaitedMs = 0;
          attempt = 0;
          continue;
        }
        throw error;
      }
      // Silent waits read as a hang from the UI; the server terminal at least says
      // what the request is stuck on.
      // Phrased as progress, not outcome: these lines are surfaced in the UI's status
      // area, where "failed" reads as the final result of the action.
      console.error(
        `${label}: ${quotaError ? "rate limited" : "temporary error"}, retry ${attempt} of ${MAX_ATTEMPTS} in ${Math.round(
          delay / 1000,
        )}s (${String(error.message).slice(0, 160)})`,
      );
      totalWaitedMs += delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  GEMINI_ENDPOINT,
  completeJson,
  resolveLlm,
};

// Smoke test for a freshly configured key: `node scripts/postprocess/llm.js`
if (require.main === module) {
  const path = require("node:path");
  const { loadPostprocessConfig } = require("./config");

  const repoRoot = path.resolve(__dirname, "..", "..");
  const llm = resolveLlm(loadPostprocessConfig(repoRoot));
  if (!llm) {
    console.error(
      "No LLM configured. Put your key in postprocess.config.local.json:\n" +
        '  { "llm": { "apiKey": "..." } }',
    );
    process.exit(1);
  }

  console.log(`Testing ${llm.provider} (${llm.model})...`);
  completeJson({
    llm,
    system: "You reply with compact JSON only.",
    prompt: 'Reply with {"ok": true, "model_heard": "<one word>"}',
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        model_heard: { type: "string" },
      },
      required: ["ok"],
    },
  })
    .then((result) => {
      console.log("Response:", JSON.stringify(result));
      console.log("LLM connection works.");
    })
    .catch((error) => {
      console.error(`Smoke test failed: ${error.message}`);
      process.exit(1);
    });
}
