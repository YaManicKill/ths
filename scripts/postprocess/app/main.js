const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const { app, BrowserWindow, dialog, nativeImage } = require("electron");

const PORT = Number(process.env.THS_APP_PORT) || 4173;

// Dock-launched apps have no terminal: stdout vanishes and an uncaught exception kills
// the process with zero trace. Everything console-printed is teed into a log file
// (~/Library/Logs/THS Post-Process/main.log), and process-level failures are recorded
// before the app dies, so "the server just closed" is never a mystery again.
const logDir = app.getPath("logs");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, "main.log");

function logLine(level, parts) {
  const text = util.format(...parts);
  try {
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} [${level}] ${text}\n`,
    );
  } catch {
    // Logging must never take the app down.
  }
}

for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...parts) => {
    logLine(level, parts);
    original(...parts);
  };
}

process.on("uncaughtException", (error) => {
  logLine("fatal", [`uncaughtException: ${error?.stack || error}`]);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logLine("fatal", [`unhandledRejection: ${reason?.stack || reason}`]);
});

logLine("log", [`app starting (pid ${process.pid}, port ${PORT})`]);
app.on("quit", () => logLine("log", ["app quit"]));

// The pipeline code is loaded from the repo checkout, not bundled into the app, so
// day-to-day changes to the tool are picked up without rebuilding the app. A packaged
// .app can live anywhere (Applications, the dock), so the repo location is baked in at
// build time by `npm run dist`; the unpackaged `npm start` case derives it from here.
function resolveRepoRoot() {
  if (process.env.THS_REPO_ROOT) {
    return process.env.THS_REPO_ROOT;
  }
  if (!app.isPackaged) {
    return path.resolve(__dirname, "..", "..", "..");
  }
  const baked = require("./package.json").thsRepoRoot;
  if (baked && fs.existsSync(baked)) {
    return baked;
  }
  throw new Error(
    "Could not locate the ths repo. Rebuild the app with `npm run dist` from " +
      "scripts/postprocess/app, or set THS_REPO_ROOT.",
  );
}

// Dock-launched apps get the minimal system PATH, which is missing homebrew - where
// ffmpeg/ffprobe (and possibly python3) live. The pipeline resolves tools from PATH.
process.env.PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "",
].join(":");

function createWindow(url, server) {
  const window = new BrowserWindow({
    width: 1280,
    height: 960,
    title: "THS Post-Process",
  });
  window.loadURL(url);

  // Closing the window kills the in-process server - and any render with it - so an
  // active job earns a confirmation instead of dying silently.
  window.on("close", (event) => {
    if (!server?.hasActiveJobs?.()) {
      return;
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["Keep Running", "Quit Anyway"],
      defaultId: 0,
      cancelId: 0,
      message: "A render or clip generation is still in progress.",
      detail: "Quitting now will kill it partway through.",
    });
    if (choice === 0) {
      event.preventDefault();
    }
  });

  if (process.env.THS_APP_SMOKE) {
    window.webContents.once("did-finish-load", () => {
      console.log(`SMOKE_OK ${url}`);
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  let repoRoot;
  let launch;
  let buildUiLaunchUrl;
  let startServer;
  try {
    repoRoot = resolveRepoRoot();
    const cli = require(
      path.join(repoRoot, "scripts", "postprocess", "cli.js"),
    );
    buildUiLaunchUrl = cli.buildUiLaunchUrl;
    startServer = require(
      path.join(repoRoot, "scripts", "postprocess", "web", "server.js"),
    ).startServer;
    launch = cli.prepareLaunch({ repoRoot });
  } catch (error) {
    dialog.showErrorBox(
      "THS Post-Process",
      `Could not prepare the next episode:\n\n${error.message}`,
    );
    app.quit();
    return;
  }

  if (process.platform === "darwin") {
    const iconPath = path.join(__dirname, "build", "icon.png");
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  const server = startServer({
    port: PORT,
    onPortConflict: () => {
      dialog.showErrorBox(
        "THS Post-Process",
        `Port ${PORT} is already in use - is the terminal version ` +
          "(npm run postprocess) already running?",
      );
      app.quit();
    },
  });

  server.once("listening", () => {
    createWindow(buildUiLaunchUrl(PORT, launch.defaults), server);
  });
});

// This is a weekly appliance: closing the window means "done", so the server dies with
// it rather than lingering as a dockless background process.
app.on("window-all-closed", () => {
  app.quit();
});
