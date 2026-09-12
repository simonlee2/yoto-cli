# yoto-cli

Agent-ready tooling for user-owned Yoto Make Your Own playlists.

The repository contains two layers:

- `.agents/skills/yoto/` — the canonical repository skill for Codex and other
  Agent Skills-compatible clients.
- `scripts/` — deterministic commands for Yoto operations, manifest uploads,
  icon assignments, and icon validation.

The repository includes reusable tools and generic workflow instructions. Keep
personal playlists, manifests, audio files, and account credentials outside it.

## Install

Requires Python 3.9+, Node.js with `npx`, and Git.

```bash
git clone https://github.com/simonlee2/yoto-cli.git
cd yoto-cli
uv tool install -e . --force
```

If `uv` is unavailable:

```bash
python3 -m pip install --user -e .
```

The install exposes:

- `yoto-cli`
- `yoto-upload-manifest`
- `yoto-apply-icons`
- `yoto-validate-icon`

The wrapper pins its upstream dependency to `@lizozom/yoto@0.3.3` so behavior
does not change between runs without a reviewed repository update.

Verify the installation:

```bash
yoto-cli --help
yoto-cli --json doctor
```

## Authentication

Create a public/native client at `https://dashboard.yoto.dev/` with this exact
redirect URI:

```text
http://127.0.0.1:8787/callback
```

Then start the PKCE browser flow on the same computer:

```bash
YOTO_CLIENT_ID='<public-client-id>' yoto-cli login
```

The public client ID can come from `YOTO_CLIENT_ID` or the upstream CLI's local
`~/.yoto-cli/config.json`. That config may contain OAuth credentials: keep it
outside repositories, restrict it with `chmod 600`, and never paste its
contents or an OAuth callback URL into chat or a shell command.

## Common operations

```bash
# Check configuration and authentication
yoto-cli --json doctor
yoto-cli status

# Inspect MYO playlists
yoto-cli cards
yoto-cli show <card-id>

# Add one local audio entry
yoto-cli add-entry <card-id> 'Clean Track Title' '/absolute/path/audio.mp3'

# Search and assign a public Yoto icon
yoto-cli icons --tag animal
yoto-cli update-icon <card-id> <zero-based-index> --media-id <media-id> --dry-run
yoto-cli update-icon <card-id> <zero-based-index> --media-id <media-id>

# Validate and preview a custom 16x16 icon
yoto-validate-icon icon.png --preview icon-preview.png

# Preview and upload an audio manifest
yoto-upload-manifest <card-id> manifest.json --base-dir /absolute/audio --dry-run
yoto-upload-manifest <card-id> manifest.json --base-dir /absolute/audio

# Preview and apply an icon manifest
yoto-apply-icons <card-id> icons.json --dry-run
yoto-apply-icons <card-id> icons.json
```

Built-in Yoto icons are assigned as `yoto:#<mediaId>`. The wrapper accepts a
bare media ID and adds the prefix.

The standalone icon examples in `scripts/make_yoto_icon.py` and
`scripts/make_radish_icon.py` write to `generated-icons/` in the current directory.

## Repository boundaries

Keep these outside git:

- downloaded audio or video
- OAuth callbacks, access tokens, refresh tokens, and client secrets
- `~/.yoto-cli/config.json`
- generated archives and other large media bundles

Run the test suite with:

```bash
python3 -m unittest discover -s tests -v
```
