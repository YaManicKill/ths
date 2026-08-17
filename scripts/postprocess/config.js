const path = require("node:path");
const { DEFAULT_TIMEZONE, fileExists, readJson } = require("./utils");

const CONFIG_FILE_NAME = "postprocess.config.json";
const LOCAL_CONFIG_FILE_NAME = "postprocess.config.local.json";

const DEFAULT_CONFIG = {
  defaultAuthor: "Al McKinlay",
  releaseTimeLocal: "19:00:00",
  timezone: DEFAULT_TIMEZONE,
  outputRoot: "content/episode",
  episodesRoot: "~/Google Drive/My Drive/Projects/ths/Episodes",
  llm: {
    provider: "gemini",
    model: "gemini-3.6-flash",
    apiKey: null,
  },
  // Correct spellings of the recurring hosts. The AI transcript check treats any other
  // spelling of these names as a mistranscription.
  hostNames: ["Al", "Codey", "Jonnie", "Kevin", "Chelsea"],
  profanityWords: [
    "fuck*",
    "shit*",
    "bitch*",
    "cunt*",
    "asshole*",
    "motherfucker*",
    "damn*",
    "crap*",
  ],
};

function assertValidTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
  } catch {
    throw new Error(
      `Invalid "timezone" in ${CONFIG_FILE_NAME}: "${value}". Use an IANA zone name such as "Europe/London".`,
    );
  }
}

function assertValidReleaseTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
  const withinRange =
    match &&
    Number(match[1]) <= 23 &&
    Number(match[2]) <= 59 &&
    (match[3] === undefined || Number(match[3]) <= 59);

  if (!withinRange) {
    throw new Error(
      `Invalid "releaseTimeLocal" in ${CONFIG_FILE_NAME}: "${value}". Use 24-hour HH:MM or HH:MM:SS.`,
    );
  }
}

function assertNonEmptyString(key, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Invalid "${key}" in ${CONFIG_FILE_NAME}: expected a non-empty string.`,
    );
  }
}

const SUPPORTED_LLM_PROVIDERS = ["gemini"];

function assertValidLlm(llm) {
  if (!SUPPORTED_LLM_PROVIDERS.includes(llm.provider)) {
    throw new Error(
      `Invalid "llm.provider" in ${CONFIG_FILE_NAME}: "${llm.provider}". Supported: ${SUPPORTED_LLM_PROVIDERS.join(", ")}.`,
    );
  }
  assertNonEmptyString("llm.model", llm.model);
  if (llm.apiKey !== null && typeof llm.apiKey !== "string") {
    throw new Error(
      `Invalid "llm.apiKey" in ${CONFIG_FILE_NAME}: expected a string or null.`,
    );
  }
}

function loadPostprocessConfig(repoRoot, configPath) {
  const fullPath = configPath || path.join(repoRoot, CONFIG_FILE_NAME);
  const fileConfig = fileExists(fullPath) ? readJson(fullPath) : {};

  // The main config is committed to a public repo, so secrets like the LLM API key live
  // in a gitignored local file that overlays it.
  const localPath = path.join(path.dirname(fullPath), LOCAL_CONFIG_FILE_NAME);
  const localConfig = fileExists(localPath) ? readJson(localPath) : {};

  // A configured list REPLACES the defaults - the defaults only apply when the key is
  // absent - so removing a word from the config actually removes it. The local overlay
  // still adds on top of whichever base: it is where words too crude for the public
  // repo's committed config would go.
  const baseProfanityWords = Array.isArray(fileConfig.profanityWords)
    ? fileConfig.profanityWords
    : DEFAULT_CONFIG.profanityWords;
  const configuredProfanityWords = [
    ...baseProfanityWords,
    ...(Array.isArray(localConfig.profanityWords)
      ? localConfig.profanityWords
      : []),
  ];

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...localConfig,
    llm: {
      ...DEFAULT_CONFIG.llm,
      ...(fileConfig.llm || {}),
      ...(localConfig.llm || {}),
    },
    profanityWords: [...new Set(configuredProfanityWords)],
  };

  if (config.llm.apiKey === "") {
    config.llm.apiKey = null;
  }

  assertValidTimezone(config.timezone);
  assertValidReleaseTime(config.releaseTimeLocal);
  assertValidLlm(config.llm);
  if (
    !Array.isArray(config.hostNames) ||
    config.hostNames.some(
      (name) => typeof name !== "string" || name.trim() === "",
    )
  ) {
    throw new Error(
      `Invalid "hostNames" in ${CONFIG_FILE_NAME}: expected an array of non-empty strings.`,
    );
  }
  for (const key of ["defaultAuthor", "outputRoot", "episodesRoot"]) {
    assertNonEmptyString(key, config[key]);
  }

  return config;
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  LOCAL_CONFIG_FILE_NAME,
  loadPostprocessConfig,
};
