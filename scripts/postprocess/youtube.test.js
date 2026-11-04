const test = require("node:test");
const assert = require("node:assert");
const {
  buildAuthUrl,
  ensureVideoInPlaylist,
  findPlaylistByTitle,
} = require("./youtube");

test("the auth url asks for upload and playlist management together", () => {
  const url = new URL(
    buildAuthUrl({ clientId: "c", redirectUri: "http://127.0.0.1:1/cb" }),
  );
  const scopes = url.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/youtube.upload"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/youtube"));
});

test("findPlaylistByTitle walks pages and matches case-insensitively", async () => {
  const pages = [
    {
      items: [{ id: "p1", snippet: { title: "Interviews" } }],
      nextPageToken: "page-2",
    },
    { items: [{ id: "p2", snippet: { title: "Year 3, Winter" } }] },
  ];
  const fetchImpl = async (url) => {
    const page = new URL(url).searchParams.get("pageToken")
      ? pages[1]
      : pages[0];
    return { ok: true, json: async () => page };
  };

  const playlist = await findPlaylistByTitle({
    accessToken: "t",
    title: "year 3, winter",
    fetchImpl,
  });
  assert.deepStrictEqual(playlist, { id: "p2", title: "Year 3, Winter" });
});

test("ensureVideoInPlaylist inserts once and is a no-op when already present", async () => {
  const makeFetch = (alreadyPresent) => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/playlists")) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: "pl-9", snippet: { title: "Year 3, Winter" } }],
          }),
        };
      }
      if ((options.method || "GET") === "GET") {
        return {
          ok: true,
          json: async () => ({
            items: alreadyPresent ? [{ id: "existing-item" }] : [],
          }),
        };
      }
      return { ok: true, json: async () => ({ id: "new-item" }) };
    };
    return { fetchImpl, requests };
  };

  const fresh = makeFetch(false);
  const added = await ensureVideoInPlaylist({
    accessToken: "t",
    playlistTitle: "Year 3, Winter",
    videoId: "vid-1",
    fetchImpl: fresh.fetchImpl,
  });
  assert.deepStrictEqual(added, { status: "added", playlistId: "pl-9" });
  const insert = fresh.requests.find(
    (request) => request.options.method === "POST",
  );
  assert.deepStrictEqual(JSON.parse(insert.options.body).snippet, {
    playlistId: "pl-9",
    resourceId: { kind: "youtube#video", videoId: "vid-1" },
  });

  const repeat = makeFetch(true);
  const unchanged = await ensureVideoInPlaylist({
    accessToken: "t",
    playlistTitle: "Year 3, Winter",
    videoId: "vid-1",
    fetchImpl: repeat.fetchImpl,
  });
  assert.deepStrictEqual(unchanged, { status: "already", playlistId: "pl-9" });
  assert.ok(
    !repeat.requests.some((request) => request.options.method === "POST"),
    "a repeat run must not insert a duplicate",
  );
});

test("a missing playlist is reported, not created", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ items: [] }),
  });
  const outcome = await ensureVideoInPlaylist({
    accessToken: "t",
    playlistTitle: "Year 9, Winter",
    videoId: "vid-1",
    fetchImpl,
  });
  assert.deepStrictEqual(outcome, { status: "missing-playlist" });
});
