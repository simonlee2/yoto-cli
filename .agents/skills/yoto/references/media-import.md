# Preparing remote media

Use this branch only when the user explicitly requests a remote source and is
authorized to download or transform it. The output of this branch is a local
MP3 or M4A file plus an authoritative title-to-file manifest; upload remains a
separate step in [cards-and-audio.md](cards-and-audio.md).

## Preserve identity

Record the intended title, creator when useful for matching, source URL or
stable ID, expected duration, and destination filename before downloading.
Search-result titles and generated filenames are evidence for matching, not
Yoto display titles.

For a playlist, compare the expected item count and order with the downloaded
files. Resolve missing, duplicate, or duration-mismatched items before any Yoto
upload.

## Extract only the requested media

Use the source's supported export or download mechanism when available. When a
user-authorized URL requires `yt-dlp`, inspect metadata first and select the
requested item explicitly. Avoid broad searches that silently choose the first
result.

For a requested clip, constrain the time range during extraction and verify the
result with `ffprobe`. For a complete item, verify that its duration is close
to the source metadata. Keep temporary media outside this repository.

Stop when access requires bypassing authentication, DRM, or another access
control. Do not upload a candidate whose identity or requested time range is
uncertain.

## Hand off to Yoto

Produce local MP3/M4A paths and clean titles. Preview the final manifest, then
continue with the single-entry or batch workflow in
[cards-and-audio.md](cards-and-audio.md).
