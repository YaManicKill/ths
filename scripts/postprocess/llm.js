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

  return { provider: llm.provider, model: llm.model, apiKey };
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
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Gemini request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
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

// Rate limits and transient server errors are retried with patience: the free Gemini
// tier allows only a handful of requests per minute, and its 429s name the exact wait
// ("Please retry in 36.4s"), so honoring that hint is what makes a multi-chunk review
// complete instead of failing. Auth and request-shape errors surface immediately.
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 70_000;

function retryDelayFromError(error, fallbackMs, attempt) {
  if (!/\((429|500|502|503|529)\)/.test(error.message)) {
    return null;
  }
  const hint = /retry in (\d+(?:\.\d+)?)s/i.exec(error.message);
  if (hint) {
    return Math.min(Number(hint[1]) * 1000 + 1000, MAX_RETRY_WAIT_MS);
  }
  return Math.min(fallbackMs * attempt, MAX_RETRY_WAIT_MS);
}

async function completeJson({
  llm,
  system,
  prompt,
  schema,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryDelayMs = 2000,
  fetchImpl = fetch,
}) {
  if (llm.provider !== "gemini") {
    throw new Error(`Unsupported LLM provider: ${llm.provider}`);
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await geminiCompleteJson({
        llm,
        system,
        prompt,
        schema,
        timeoutMs,
        fetchImpl,
      });
    } catch (error) {
      const delay = retryDelayFromError(error, retryDelayMs, attempt);
      if (delay === null || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
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
