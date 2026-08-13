const assert = require("node:assert/strict");
const { chapterHiddenFromMetadata } = require("./parsers");

// Plain hidden-style sources pass through.
assert.equal(chapterHiddenFromMetadata({ tags: { hidden: "1" } }), true);
assert.equal(chapterHiddenFromMetadata({ tags: { hidden: "0" } }), false);
assert.equal(chapterHiddenFromMetadata({ tags: {} }), false);
assert.equal(chapterHiddenFromMetadata({}), false);

// enabled-style sources mean the opposite.
assert.equal(chapterHiddenFromMetadata({ tags: { enabled: "0" } }), true);
assert.equal(chapterHiddenFromMetadata({ tags: { enabled: "1" } }), false);
// ffprobe dispositions are numeric: 0 must read as false, not as "no value".
assert.equal(
  chapterHiddenFromMetadata({ disposition: { enabled: 0 }, tags: {} }),
  true,
);
assert.equal(
  chapterHiddenFromMetadata({ disposition: { enabled: 1 }, tags: {} }),
  false,
);
assert.equal(
  chapterHiddenFromMetadata({ disposition: { hidden: 0 }, tags: {} }),
  false,
);

// A hidden flag whose value happens to equal the enabled flag's must not be
// mistaken for it and inverted: hidden=1 wins regardless of enabled=1.
assert.equal(
  chapterHiddenFromMetadata({ tags: { hidden: "1", enabled: "1" } }),
  true,
  "hidden=1 was inverted because enabled shared its value",
);

console.log("parsers test passed");
