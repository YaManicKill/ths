const path = require("node:path");
const { DEFAULT_TIMEZONE, fileExists, readJson } = require("./utils");

const CONFIG_FILE_NAME = "postprocess.config.json";

const DEFAULT_CONFIG = {
  defaultAuthor: "Al McKinlay",
  releaseTimeLocal: "19:00:00",
  timezone: DEFAULT_TIMEZONE,
  outputRoot: "content/episode",
  episodesRoot: "~/Google Drive/My Drive/Projects/ths/Episodes",
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

function loadPostprocessConfig(repoRoot, configPath) {
  const fullPath = configPath || path.join(repoRoot, CONFIG_FILE_NAME);
  const fileConfig = fileExists(fullPath) ? readJson(fullPath) : {};

  const configuredProfanityWords = Array.isArray(fileConfig.profanityWords)
    ? fileConfig.profanityWords
    : [];

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    profanityWords: [
      ...new Set([
        ...DEFAULT_CONFIG.profanityWords,
        ...configuredProfanityWords,
      ]),
    ],
  };

  assertValidTimezone(config.timezone);
  assertValidReleaseTime(config.releaseTimeLocal);
  for (const key of ["defaultAuthor", "outputRoot", "episodesRoot"]) {
    assertNonEmptyString(key, config[key]);
  }

  return config;
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadPostprocessConfig,
};
