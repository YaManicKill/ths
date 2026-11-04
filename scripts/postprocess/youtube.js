const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

// YouTube uploads require OAuth (API keys cannot upload), so the flow is: a one-time
// browser authorization against the user's own OAuth client, a stored refresh token,
// and then the Data API's resumable upload protocol - all over node builtins.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const PLAYLISTS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlists";
const PLAYLIST_ITEMS_ENDPOINT =
  "https://www.googleapis.com/youtube/v3/playlistItems";
// youtube.upload cannot touch playlists; this is the scope that can read and edit
// them. Tokens granted before it was requested can upload but not manage playlists.
const MANAGE_SCOPE = "https://www.googleapis.com/auth/youtube";

// Credentials come from the gitignored local config; without them the upload feature
// simply is not available.
function resolveYoutube(config) {
  const youtube = config?.youtube || {};
  if (!youtube.clientId || !youtube.clientSecret) {
    return null;
  }
  return {
    clientId: youtube.clientId,
    clientSecret: youtube.clientSecret,
    titleTemplate: youtube.titleTemplate || "{mainTopic} Review",
    categoryId: String(youtube.categoryId || "20"),
  };
}

function renderTitleTemplate(template, values) {
  return String(template || "")
    .replace(/\{mainTopic\}/g, values.mainTopic || "")
    .replace(/\{title\}/g, values.title || "")
    .replace(/\{code\}/g, values.code || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAuthUrl({ clientId, redirectUri, authEndpoint }) {
  const url = new URL(authEndpoint || AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", `${UPLOAD_SCOPE} ${MANAGE_SCOPE}`);
  // offline + consent is what makes Google hand back a refresh token every time.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function postTokenRequest(params, tokenEndpoint) {
  const response = await fetch(tokenEndpoint || TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Token request failed (${response.status}): ${body.error || ""} ${body.error_description || ""}`.trim(),
    );
  }
  return body;
}

function exchangeCodeForToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  tokenEndpoint,
}) {
  return postTokenRequest(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    tokenEndpoint,
  );
}

function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  tokenEndpoint,
}) {
  return postTokenRequest(
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    tokenEndpoint,
  );
}

async function youtubeApiRequest({
  url,
  accessToken,
  method = "GET",
  body,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `YouTube API error (${response.status}): ${data.error?.message || "unknown"}`,
    );
  }
  return data;
}

// The channel keeps one podcast playlist per show season; titles are the only
// addressable name they have, so the lookup walks the channel's playlists.
async function findPlaylistByTitle({
  accessToken,
  title,
  endpoint,
  fetchImpl,
}) {
  const target = String(title).trim().toLowerCase();
  let pageToken;
  do {
    const url = new URL(endpoint || PLAYLISTS_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const data = await youtubeApiRequest({ url, accessToken, fetchImpl });
    const match = (data.items || []).find(
      (item) =>
        String(item.snippet?.title || "")
          .trim()
          .toLowerCase() === target,
    );
    if (match) {
      return { id: match.id, title: match.snippet.title };
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return null;
}

// Idempotent: re-running for an episode that is already in the playlist is a no-op,
// so a repeat Upload click can repair older episodes safely.
async function ensureVideoInPlaylist({
  accessToken,
  playlistTitle,
  videoId,
  playlistsEndpoint,
  playlistItemsEndpoint,
  fetchImpl,
}) {
  const playlist = await findPlaylistByTitle({
    accessToken,
    title: playlistTitle,
    endpoint: playlistsEndpoint,
    fetchImpl,
  });
  if (!playlist) {
    return { status: "missing-playlist" };
  }

  const checkUrl = new URL(playlistItemsEndpoint || PLAYLIST_ITEMS_ENDPOINT);
  checkUrl.searchParams.set("part", "id");
  checkUrl.searchParams.set("playlistId", playlist.id);
  checkUrl.searchParams.set("videoId", videoId);
  const existing = await youtubeApiRequest({
    url: checkUrl,
    accessToken,
    fetchImpl,
  });
  if ((existing.items || []).length > 0) {
    return { status: "already", playlistId: playlist.id };
  }

  const insertUrl = new URL(playlistItemsEndpoint || PLAYLIST_ITEMS_ENDPOINT);
  insertUrl.searchParams.set("part", "snippet");
  await youtubeApiRequest({
    url: insertUrl,
    accessToken,
    method: "POST",
    body: {
      snippet: {
        playlistId: playlist.id,
        resourceId: { kind: "youtube#video", videoId },
      },
    },
    fetchImpl,
  });
  return { status: "added", playlistId: playlist.id };
}

// The Data API's resumable protocol: one POST with the metadata returns an upload URL
// in the Location header, then the file streams to it in a single PUT (fine at any
// episode size; "resumable" is just the protocol's name).
async function uploadVideoToYoutube({
  filePath,
  accessToken,
  snippet,
  status,
  uploadEndpoint,
  onProgress = () => {},
}) {
  const stat = fs.statSync(filePath);

  const initUrl = new URL(uploadEndpoint || UPLOAD_ENDPOINT);
  initUrl.searchParams.set("uploadType", "resumable");
  initUrl.searchParams.set("part", "snippet,status");
  const initResponse = await fetch(initUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-type": "video/mp4",
      "x-upload-content-length": String(stat.size),
    },
    body: JSON.stringify({ snippet, status }),
  });
  if (!initResponse.ok) {
    const body = await initResponse.text().catch(() => "");
    throw new Error(
      `YouTube upload init failed (${initResponse.status}): ${body.slice(0, 300)}`,
    );
  }
  const location = initResponse.headers.get("location");
  if (!location) {
    throw new Error("YouTube upload init returned no upload URL");
  }

  const uploadUrl = new URL(location);
  const responseBody = await new Promise((resolve, reject) => {
    const lib = uploadUrl.protocol === "http:" ? http : https;
    const request = lib.request(
      {
        hostname: uploadUrl.hostname,
        port: uploadUrl.port || undefined,
        method: "PUT",
        path: `${uploadUrl.pathname}${uploadUrl.search}`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "video/mp4",
          "content-length": stat.size,
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(body);
          } else {
            reject(
              new Error(
                `YouTube upload failed (${response.statusCode}): ${body.slice(0, 300)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);

    let sentBytes = 0;
    const fileStream = fs.createReadStream(filePath);
    fileStream.on("data", (chunk) => {
      sentBytes += chunk.length;
      onProgress({
        sentBytes,
        totalBytes: stat.size,
        percent: Math.round((sentBytes / stat.size) * 100),
      });
    });
    fileStream.on("error", (error) => {
      request.destroy(error);
      reject(error);
    });
    fileStream.pipe(request);
  });

  const video = JSON.parse(responseBody || "{}");
  if (!video.id) {
    throw new Error("YouTube upload response carried no video id");
  }
  return {
    videoId: video.id,
    url: `https://www.youtube.com/watch?v=${video.id}`,
  };
}

module.exports = {
  MANAGE_SCOPE,
  buildAuthUrl,
  ensureVideoInPlaylist,
  exchangeCodeForToken,
  findPlaylistByTitle,
  refreshAccessToken,
  renderTitleTemplate,
  resolveYoutube,
  uploadVideoToYoutube,
};
