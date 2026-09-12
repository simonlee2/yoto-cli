---
name: yoto
description: Manage user-owned Yoto Make Your Own playlists and prepare authorized audio sources with the repository's yoto-cli wrapper. Use for Yoto authentication checks, card inspection, audio uploads, clean-title manifests, and 16x16 display icons; not for purchased cards or device control.
---

# Yoto MYO operations

Use `yoto-cli` as the execution boundary. It pins the upstream CLI, supplies the
public client ID without exposing stored tokens, and keeps routine operations
scriptable.

## Start safely

1. Run `yoto-cli --json doctor`.
2. If the command is missing and this repository is checked out, install it
   from the repository root with `uv tool install -e . --force`. When `uv` is
   unavailable, use `python3 -m pip install --user -e .`.
3. If configuration or login fails, read
   [references/authentication.md](references/authentication.md).
4. Before changing a card, run `yoto-cli show <card-id>` and identify the card
   by both title and ID.

A clear user request authorizes the described add or update. Show the exact
target and obtain confirmation immediately before deletion, replacement of a
whole card, or a batch whose title-to-file mapping was inferred rather than
provided.

## Route the operation

- For a local audio upload or manifest batch, read
  [references/cards-and-audio.md](references/cards-and-audio.md).
- For a user-requested Spotify, YouTube, or other remote source, read
  [references/media-import.md](references/media-import.md) before producing
  local audio.
- For official or custom track icons, read
  [references/icons.md](references/icons.md).
- For current wrapper syntax, inspect `yoto-cli --help` and the relevant
  subcommand help instead of copying commands from historical session notes.

Operate only on user-owned MYO content. Treat card IDs, library titles, child
names, and listening data as private; surface only the fields needed for the
requested decision. Physical-card linking remains a user action in the Yoto
app.

## Mutation invariants

- Build titles from the user's manifest or another authoritative source, not
  downloaded filenames or search-result titles.
- Use zero-based entry indexes only after fetching the latest card state.
- A timed-out or malformed response can follow a successful upload. Inspect the
  card before retrying so an entry is not duplicated.
- Give every newly added entry an intentional display icon. Prefer an exact
  public Yoto icon; create a custom sprite when the public library has no clear
  match.
- Keep the repository free of audio, OAuth callbacks, tokens, and client
  secrets.

## Completion

After every write, fetch the card again and verify the requested title, chapter
count or order, and relevant track data. Icon work is complete only when both
the chapter and its first track reference the intended `display.icon16x16`.
