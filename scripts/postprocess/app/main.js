const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, nativeImage } = require("electron");

const PORT = Number(process.env.THS_APP_PORT) || 4173;

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

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 960,
    title: "THS Post-Process",
  });
  window.loadURL(url);

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
    createWindow(buildUiLaunchUrl(PORT, launch.defaults));
  });
});

// This is a weekly appliance: closing the window means "done", so the server dies with
// it rather than lingering as a dockless background process.
app.on("window-all-closed", () => {
  app.quit();
});
