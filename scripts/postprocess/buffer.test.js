const test = require("node:test");
const assert = require("node:assert");
const {
  createBufferVideoPost,
  listBufferChannels,
  resolveBuffer,
  ukEveningToUtcIso,
} = require("./buffer");

test("ukEveningToUtcIso handles GMT and BST", () => {
  // Winter: UK is on GMT, 7pm local is 7pm UTC.
  assert.strictEqual(
    ukEveningToUtcIso("2026-12-10"),
    "2026-12-10T19:00:00.000Z",
  );
  // Summer: UK is on BST, 7pm local is 6pm UTC.
  assert.strictEqual(
    ukEveningToUtcIso("2026-07-10"),
    "2026-07-10T18:00:00.000Z",
  );
  assert.throws(() => ukEveningToUtcIso("next thursday"), /Invalid/);
});

test("resolveBuffer requires an api key", () => {
  assert.strictEqual(resolveBuffer({}), null);
  assert.deepStrictEqual(resolveBuffer({ buffer: { apiKey: "k" } }), {
    apiKey: "k",
  });
});

test("createBufferVideoPost sends the scheduled video post", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: { createPost: { post: { id: "post-1", dueAt: "due" } } },
      }),
    };
  };

  const post = await createBufferVideoPost({
    apiKey: "key-1",
    channelId: "chan-1",
    text: "A caption",
    dueAt: "2026-10-29T19:00:00.000Z",
    videoUrl: "https://cdn.example.com/clip.mp4",
    fetchImpl,
  });

  assert.strictEqual(post.id, "post-1");
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].options.headers.authorization, "Bearer key-1");
  const body = JSON.parse(requests[0].options.body);
  assert.deepStrictEqual(body.variables.input, {
    channelId: "chan-1",
    text: "A caption",
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: "2026-10-29T19:00:00.000Z",
    assets: [{ video: { url: "https://cdn.example.com/clip.mp4" } }],
  });
});

test("a youtube channel's post carries the required video metadata", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: { createPost: { post: { id: "post-2", dueAt: "due" } } },
      }),
    };
  };

  await createBufferVideoPost({
    apiKey: "k",
    channelId: "chan-yt",
    service: "youtube",
    title:
      "A very long clip title that would overflow the one hundred character limit youtube places on video titles",
    text: "Description text #cozygames",
    dueAt: "2026-10-30T19:00:00.000Z",
    videoUrl: "https://cdn.example.com/clip.mp4",
    fetchImpl,
  });

  const input = JSON.parse(requests[0].options.body).variables.input;
  assert.strictEqual(input.metadata.youtube.categoryId, "20");
  assert.strictEqual(input.metadata.youtube.title.length, 100);
  assert.ok(input.metadata.youtube.title.startsWith("A very long clip title"));
});

test("createBufferVideoPost surfaces Buffer's rejection message", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: { createPost: { message: "Video is too long for tiktok" } },
    }),
  });

  await assert.rejects(
    createBufferVideoPost({
      apiKey: "k",
      channelId: "c",
      text: "t",
      dueAt: "d",
      videoUrl: "https://v",
      fetchImpl,
    }),
    /Video is too long for tiktok/,
  );
});

test("listBufferChannels collects connected channels across organizations", async () => {
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes("organizations")) {
      return {
        ok: true,
        json: async () => ({
          data: { account: { organizations: [{ id: "org-1" }] } },
        }),
      };
    }
    assert.strictEqual(body.variables.organizationId, "org-1");
    return {
      ok: true,
      json: async () => ({
        data: {
          channels: [
            {
              id: "c1",
              name: "harvestseason",
              service: "bluesky",
              isDisconnected: false,
            },
            {
              id: "c2",
              name: "old",
              service: "mastodon",
              isDisconnected: true,
            },
          ],
        },
      }),
    };
  };

  const channels = await listBufferChannels({ apiKey: "k", fetchImpl });
  assert.deepStrictEqual(channels, [
    { id: "c1", name: "harvestseason", service: "bluesky" },
  ]);
});

test("graphql errors become readable failures", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: "Not authorized" }] }),
  });
  await assert.rejects(
    listBufferChannels({ apiKey: "bad", fetchImpl }),
    /Not authorized/,
  );
});
