#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  discoverEpisodeInputs,
  discoverLatestEpisodeInputs,
} = require("./episode-discovery");
const { readJson } = require("./utils");
const { inferNextSeasonEpisode } = require("./sequence-inference");

const DEFAULT_EPISODES_ROOT = "~/Google Drive/My Drive/Projects/ths/Episodes";

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, "postprocess.config.json");
  return readJson(configPath, {});
}

function getEpisodesRoot(repoRoot, argValue) {
  const config = loadConfig(repoRoot);
  return config.episodesRoot || DEFAULT_EPISODES_ROOT;
}

function resolveSeasonEpisode({ repoRoot, args }) {
  const forceNewSeason = Boolean(args["new-season"]);

  const config = loadConfig(repoRoot);
  const contentEpisodeRoot = path.join(
    repoRoot,
    config.outputRoot || "content/episode",
  );
  const inferred = inferNextSeasonEpisode({
    contentEpisodeRoot,
    releaseTimeLocal: config.releaseTimeLocal || "19:00:00",
    timezoneOffset: config.timezoneOffset || "+01:00",
  });

  if (forceNewSeason && inferred.basedOn) {
    const nextSeason = Number(inferred.basedOn.lastSeason) + 1;
    return {
      season: String(nextSeason).padStart(2, "0"),
      episode: "01",
      inferred: true,
      metadata: {
        ...inferred,
        seasonCode: String(nextSeason).padStart(2, "0"),
        episodeCode: "01",
        seasonNumber: nextSeason,
        episodeNumber: 1,
        reason: "manual-new-season",
      },
    };
  }

  return {
    season: inferred.seasonCode,
    episode: inferred.episodeCode,
    inferred: true,
    metadata: inferred,
  };
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function buildUiLaunchUrl(port, defaults) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, String(value));
  }

  const queryString = query.toString();
  return queryString
    ? `http://localhost:${port}/?${queryString}`
    : `http://localhost:${port}/`;
}

function printUsage() {
  console.log("THS post-processing");
  console.log("");
  console.log("Launch prefilled web UI for the next episode:");
  console.log(
    "  node scripts/postprocess/cli.js [episode] [--dry-run] [--new-season]",
  );
  console.log("  episode         Open the web UI (default command if omitted)");
  console.log("  --dry-run       Start UI with dry-run checked");
  console.log("  --new-season    Force next season, episode 01");
}

function logInferenceContext(metadata) {
  if (!metadata || !metadata.basedOn) {
    return;
  }

  const { basedOn } = metadata;
  const lastDate = new Date(basedOn.lastDate).toISOString().slice(0, 10);
  const nextPublish = new Date(basedOn.nextPublish).toISOString().slice(0, 10);

  console.log(
    `Inference context: last ths-${String(basedOn.lastSeason).padStart(2, "0")}-${String(basedOn.lastEpisode).padStart(2, "0")} (${lastDate}) -> next publish ${nextPublish}`,
  );
}

function parseArgs(argv) {
  const args = {
    _: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  if (command && command !== "episode") {
    printUsage();
    process.exit(1);
  }

  const allowedFlags = new Set(["dry-run", "new-season", "help", "h"]);
  const providedFlags = Object.keys(args).filter((key) => key !== "_");
  const unknownFlags = providedFlags.filter((key) => !allowedFlags.has(key));
  if (unknownFlags.length > 0) {
    console.error(
      `Unsupported option(s): ${unknownFlags.map((v) => `--${v}`).join(", ")}`,
    );
    printUsage();
    process.exit(1);
  }

  const resolved = resolveSeasonEpisode({ repoRoot, args });
  const episodesRoot = getEpisodesRoot(repoRoot);
  let discovered;
  try {
    discovered = discoverEpisodeInputs({
      episodesRoot,
      season: resolved.season,
      episode: resolved.episode,
    });
  } catch (error) {
    discovered = discoverLatestEpisodeInputs({ episodesRoot });
    console.warn(
      `Requested inferred episode ths-${String(resolved.season).padStart(2, "0")}-${String(resolved.episode).padStart(2, "0")} not found; using latest available on disk instead.`,
    );
  }
  const port = 4173;

  const defaults = {
    mp3Path: discovered.mp3Path,
    transcriptMdPath: discovered.transcriptMdPath,
    transcriptVttPath: discovered.transcriptVttPath,
    episodeTitle: discovered.episodeTitle,
    dryRun: args["dry-run"] ? "1" : "0",
    autoRun: "0",
  };

  const serverPath = path.join(__dirname, "web", "server.js");
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { startServer } = require(serverPath);
  startServer({ port });

  const url = buildUiLaunchUrl(port, defaults);
  openBrowser(url);

  console.log(`Discovered episode folder: ${discovered.folderPath}`);
  console.log(
    `Episode code: ths-${String(resolved.season).padStart(2, "0")}-${String(resolved.episode).padStart(2, "0")}`,
  );
  if (resolved.inferred && resolved.metadata) {
    console.log(`Inferred sequence using rule: ${resolved.metadata.reason}`);
    logInferenceContext(resolved.metadata);
  }
  console.log(`UI opened: ${url}`);
}

main().catch((error) => {
  console.error(`Post-processing failed: ${error.message}`);
  process.exit(1);
});
