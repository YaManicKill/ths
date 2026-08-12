const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// app.js is a plain browser script, so load it into a stubbed DOM and reach in at the
// status-log helpers. Enough of the environment is faked for the top-level code to run.
function loadApp() {
  const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

  function makeElement() {
    const element = {
      style: {},
      dataset: {},
      children: [],
      textContent: "",
      innerHTML: "",
      value: "",
      checked: false,
      disabled: false,
      type: "text",
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      remove() {},
      click() {},
      elements: { namedItem: () => null },
    };
    return element;
  }

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, makeElement());
      }
      return elements.get(id);
    },
    createElement: makeElement,
    addEventListener() {},
  };

  const context = {
    document,
    window: {
      addEventListener() {},
      removeEventListener() {},
      location: { search: "" },
      confirm: () => false,
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    navigator: {},
    // Any network call would be a bug in this test: nothing here should reach the server.
    fetch: () =>
      Promise.reject(new Error("fetch is not stubbed for this test")),
    FormData: class {
      get() {
        return "";
      }
    },
    URLSearchParams,
    FileReader: class {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(source, context);

  return { context, resultBox: document.getElementById("result") };
}

const { context, resultBox } = loadApp();
const { addStatus, setStatusLine, resetStatus, findStatusLineId } = context;

resetStatus();

// A held line id keeps addressing the same line as other lines arrive around it.
const renderId = addStatus("MP4 generation 0%");
addStatus("some other message");
setStatusLine(renderId, "MP4 generation 50%");
assert.ok(
  resultBox.textContent.includes("MP4 generation 50%"),
  "update did not reach the held line",
);
assert.ok(
  !resultBox.textContent.includes("MP4 generation 0%"),
  "old text was left behind",
);
assert.ok(
  resultBox.textContent.includes("some other message"),
  "an unrelated line was overwritten",
);

// The bug: resetStatus() empties the log while a poller still holds a handle. Updates
// must still appear rather than being dropped or landing on another line.
resetStatus();
addStatus("Discovering episode data...");
setStatusLine(renderId, "MP4 generation 75%");
assert.ok(
  resultBox.textContent.includes("MP4 generation 75%"),
  "progress was lost after resetStatus()",
);
assert.ok(
  resultBox.textContent.includes("Discovering episode data..."),
  "resetStatus() line was clobbered by the re-added progress line",
);

// Continuing to update the same handle must not keep appending duplicates.
setStatusLine(renderId, "MP4 generation 90%");
setStatusLine(renderId, "✓ MP4 generation complete");
const completeCount = resultBox.textContent
  .split("\n")
  .filter((line) => line.includes("MP4 generation")).length;
assert.equal(completeCount, 1, "the progress line was duplicated");

// Ids must be unique even across a reset, so a stale handle can never collide with a
// freshly added line.
resetStatus();
const afterReset = addStatus("brand new line");
assert.notEqual(afterReset, renderId, "ids were reused after a reset");

// findStatusLineId locates a live line so reconnecting pollers reuse it.
resetStatus();
const clipId = addStatus("⏳ Clip generation queued on server...");
assert.equal(findStatusLineId("Clip generation"), clipId);
assert.equal(findStatusLineId("nothing matches this"), null);

// Falsy text is ignored, and a null handle is a no-op rather than a crash.
assert.equal(addStatus(""), null);
setStatusLine(null, "should not throw");

console.log("app status-log test passed");
