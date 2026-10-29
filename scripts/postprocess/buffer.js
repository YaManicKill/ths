// Buffer's GraphQL API (api.buffer.com): the app creates the scheduled clip posts
// and Buffer publishes them - nothing here has to be running at publish time.
const BUFFER_ENDPOINT = "https://api.buffer.com";
const REQUEST_TIMEOUT_MS = 30_000;

function resolveBuffer(config) {
  const apiKey = config?.buffer?.apiKey || process.env.BUFFER_API_KEY || null;
  return apiKey ? { apiKey } : null;
}

async function bufferGraphql({
  apiKey,
  query,
  variables = {},
  endpoint = BUFFER_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      throw new Error(`Buffer API timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Buffer API error (${response.status})`);
  }
  const body = await response.json();
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(
      `Buffer API: ${body.errors.map((graphqlError) => graphqlError.message).join("; ")}`,
    );
  }
  return body.data;
}

// Channels are queried live rather than configured, so connecting or removing a
// network in Buffer shows up here without a config edit.
async function listBufferChannels({ apiKey, fetchImpl, endpoint }) {
  const accountData = await bufferGraphql({
    apiKey,
    fetchImpl,
    endpoint,
    query: "query Account { account { organizations { id } } }",
  });
  const organizations = accountData?.account?.organizations || [];

  const channels = [];
  for (const organization of organizations) {
    const channelData = await bufferGraphql({
      apiKey,
      fetchImpl,
      endpoint,
      query: `query Channels($organizationId: OrganizationId!) {
        channels(input: { organizationId: $organizationId }) {
          id
          name
          service
          isDisconnected
        }
      }`,
      variables: { organizationId: organization.id },
    });
    for (const channel of channelData?.channels || []) {
      if (!channel.isDisconnected) {
        channels.push({
          id: channel.id,
          name: channel.name,
          service: channel.service,
        });
      }
    }
  }
  return channels;
}

// Buffer has no upload endpoint: the video rides as a public HTTPS URL that Buffer
// fetches when the post goes out, so the file must stay reachable until then.
// Hashtags have no field of their own - they stay in the text and the network
// renders them.
async function createBufferVideoPost({
  apiKey,
  channelId,
  service,
  text,
  dueAt,
  videoUrl,
  title,
  fetchImpl,
  endpoint,
}) {
  const input = {
    channelId,
    text,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt,
    assets: [{ video: { url: videoUrl } }],
  };
  // YouTube refuses a bare text post: the video needs its own title (100 chars
  // max) and category - 20 is Gaming, matching the episode uploads. The text
  // becomes the description.
  if (String(service || "").toLowerCase() === "youtube") {
    input.metadata = {
      youtube: {
        title: String(title || text || "").slice(0, 100),
        categoryId: 20,
      },
    };
  }

  const data = await bufferGraphql({
    apiKey,
    fetchImpl,
    endpoint,
    query: `mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id dueAt } }
        ... on MutationError { message }
      }
    }`,
    variables: { input },
  });
  const result = data?.createPost;
  if (!result?.post?.id) {
    throw new Error(
      `Buffer rejected the post: ${result?.message || "no post id returned"}`,
    );
  }
  return result.post;
}

// Buffer wants dueAt in UTC; the show's schedule is UK local time, which flips
// between GMT and BST through the year.
function ukEveningToUtcIso(dateString, hour = 19) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ""))) {
    throw new Error(`Invalid schedule date: ${dateString}`);
  }
  const naiveUtc = new Date(
    `${dateString}T${String(hour).padStart(2, "0")}:00:00Z`,
  );
  if (Number.isNaN(naiveUtc.getTime())) {
    throw new Error(`Invalid schedule date: ${dateString}`);
  }
  const offsetName = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  })
    .formatToParts(naiveUtc)
    .find((part) => part.type === "timeZoneName")?.value;
  const offsetMatch = /([+-])(\d{2}):(\d{2})/.exec(offsetName || "");
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === "-" ? -1 : 1) *
      (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
    : 0;
  return new Date(naiveUtc.getTime() - offsetMinutes * 60_000).toISOString();
}

module.exports = {
  BUFFER_ENDPOINT,
  bufferGraphql,
  createBufferVideoPost,
  listBufferChannels,
  resolveBuffer,
  ukEveningToUtcIso,
};
