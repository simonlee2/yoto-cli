# Yoto playlist tools

Browse and manage your own Yoto Make Your Own playlists from an assistant or the
command line. Use the hosted MCP connector for playlist edits without installing
the CLI; use the CLI for local audio uploads and icon workflows.

## Connect your assistant

Add this MCP server URL to your assistant:

```text
https://yoto-connector.dev-simonlee.workers.dev/mcp
```

In [ChatGPT Plugins](https://chatgpt.com/plugins), add a connection using this URL
and sign in with Yoto. For an existing connection, choose **Refresh** to discover
updated tools, then start a new conversation with Yoto enabled. Refreshing tools
and authorizing additional permissions are separate actions.

Reading requires read access. To edit playlists, ask the assistant to prepare a
change and complete the management authorization prompt. The consent page should
say **read and manage**. Existing read-only connections are not upgraded silently.
You sign in on Yoto's site; never share passwords, tokens or callback URLs in chat.

See the [connector guide](server/README.md) for setup, tools and permissions.

## Use the connector

Examples:

- “List my MYO playlists.”
- “Show the chapters in this playlist.”
- “Prepare a new title for this playlist; show me the preview before applying.”
- “Preview moving this chapter to the start.”

The connector can create empty playlists, edit titles/descriptions, add and rename
chapters, rename tracks, reorder chapters/tracks, set existing Yoto icons, copy
supported audio tracks between your own playlists, and remove individual tracks.
Changes use **prepare → review → confirm → apply**. Previews expire after ten
minutes. If a change reports an uncertain outcome, read the playlist before
preparing another change.

Hosted audio and custom-icon uploads are disabled. Use the CLI below for uploads.
The connector does not delete whole playlists, control players, or provide
commercial-card audio. Physical MYO-card linking stays in the Yoto app.

## Install the CLI

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

## CLI authentication

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

## CLI usage

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

## Credentials and disconnecting

If the CLI asks you to sign in, run `yoto-cli login`. After an interrupted upload
or playlist change, inspect the playlist before trying the operation again.

For the hosted connector, ask the assistant to disconnect Yoto to delete that
connection's saved credentials, then remove the connection from the assistant.
Other connections are separate. Removing the assistant connection alone does not
immediately delete saved Yoto credentials; unused credentials expire after 30 days
without a successful playlist read. See the [privacy page](https://yoto-connector.dev-simonlee.workers.dev/privacy).

Keep credentials, personal manifests and downloaded audio outside this repository.
The [Yoto agent skill](.agents/skills/yoto/SKILL.md) provides reusable workflows
for compatible coding assistants.
