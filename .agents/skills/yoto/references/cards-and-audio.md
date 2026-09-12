# Cards and audio

## Inspect before changing

```bash
yoto-cli cards
yoto-cli show <card-id>
```

Confirm the title and card ID. For audio, accept local MP3 or M4A files and use
`ffprobe` when duration, codec, or file integrity is uncertain.

## Add one entry

Choose a clean display title from the user's source of truth, then run:

```bash
yoto-cli add-entry <card-id> '<clean title>' '/absolute/path/audio.mp3'
```

Use the track title alone unless the user asks for artist names. After the
audio appears, follow [icons.md](icons.md) and assign an intentional icon; an
automatic placeholder is not a finished choice unless it is appropriate and
verified.

Fetch the card again before retrying a failed or interrupted command. Upload
and transcode may have completed even when the final response was lost.

## Upload a manifest

Use a JSON list with one title-to-file mapping per entry:

```json
[
  {"title": "First track", "file": "01-first.mp3"},
  {"title": "Second track", "file": "02-second.m4a"}
]
```

Preview resolution and file checks before writing:

```bash
yoto-upload-manifest <card-id> manifest.json --base-dir /absolute/audio --dry-run
```

When the preview matches the intended order, run the same command without
`--dry-run`. The uploader is sequential and is not an idempotent replay log. If
it stops partway through, inspect the live card, compare it with the manifest,
and resume only the missing suffix instead of rerunning the whole file.

After completion, verify chapter count, order, titles, and that every chapter
has one playable track and an intentional icon. Link a physical MYO card
separately in the Yoto app.

## Media provenance

The upload boundary is a local file. Download or transform remote media only
when the user explicitly requests it and is authorized to use it. Preserve a
manifest across any external search or conversion so the source title, local
file, and Yoto title cannot drift apart.
