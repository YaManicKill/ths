# Post-Processing TODOs

Waiting on a full end-to-end episode run before anything that writes off this machine:

1. Upload the finished MP3 to DigitalOcean Spaces from the UI (S3-compatible API;
   credentials belong in the gitignored local config).
2. Upload the chapter MP4 to YouTube from the UI, with the description taken from the
   existing YouTube Description generator and the publish time scheduled via the API -
   collapsing the upload/describe/schedule steps into one click.

## Maybe

- Back-catalog clip mining: a quota-aware batch mode that runs the AI clip picker over
  old episodes and queues renders, turning the archive into social content.
