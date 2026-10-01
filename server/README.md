# Yoto MCP connector

Connect an assistant to your own Yoto Make Your Own playlists. The hosted service
runs on Cloudflare; no local CLI or OpenAI API key is needed for playlist reads
and edits.

```text
https://yoto-connector.dev-simonlee.workers.dev/mcp
```

## Setup in ChatGPT

1. Enable Developer mode in Settings → Security and login if your account supports it.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), add a connection and enter the MCP URL above.
3. Follow the connector consent and Yoto sign-in flow. After the initial consent,
   Yoto opens automatically; a continuation button is available if needed.
4. Start a conversation with Yoto enabled and ask to list your playlists.

When tools change, open the existing connection and select **Refresh**, then start
a new conversation. Reconnecting an account does not replace metadata refresh.
See [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Dots uses plugins enabled on the ChatGPT account; make sure Yoto is enabled there.
Other clients need HTTPS Streamable HTTP MCP and user OAuth support. Muse setup
is not currently documented for this connector.

## Permissions

Read tools request connector scope `myo:read` and Yoto
`user:content:view offline_access`. Playlist edits additionally require connector
scope `myo:write` and Yoto `user:content:manage`.

To add management access, ask the assistant to **prepare** a playlist change.
Follow its authorization prompt and check that consent says **read and manage**.
A previous read-only grant stays read-only until you approve that authorization.
`connection_status` reports whether both layers have management permission.

The connector returns to the assistant's registered callback after Yoto sign-in.
The assistant determines which app or page opens afterward; a return to its
plugins page does not itself mean authorization failed.

## Tools and usage

| Tool | Purpose |
| --- | --- |
| `list_myo_playlists` | List your own MYO playlists. |
| `get_myo_playlist` | Read an owned playlist's chapters and tracks. |
| `connection_status` | Check saved connection and management-permission readiness. |
| `prepare_myo_change` | Create a ten-minute preview without changing a playlist. |
| `apply_myo_change` | Apply the reviewed preview after explicit confirmation. |
| `disconnect_yoto` | Delete this connection's saved Yoto credentials. |

Supported edits include empty-playlist creation, title/description changes,
chapter creation, chapter/track renaming and ordering, existing Yoto icon
assignment, copying supported durable tracks between owned playlists, and
individual track removal. Whole-playlist deletion is not available.

Ask for a preview, review the exact target and change, then confirm it. Applying
rechecks ownership and playlist revision and reads the result back. Avoid editing
the same playlist simultaneously in another app. If an operation reports an
uncertain result, read the playlist before requesting a new preview; do not
assume the write failed.

## Current limits

- Hosted audio and custom-icon uploads are disabled; use the [CLI](../README.md#cli-usage).
- No whole-playlist deletion, player control, family/profile management or commercial-card audio.
- Local audio preparation, cover artwork and animated-icon workflows remain outside the connector.
- Physical MYO-card linking is done in the Yoto app.
- Uploads and playlist editing are separate settings; enabling edits does not enable uploads.

## Privacy and disconnecting

Each connection stores encrypted Yoto credentials. Passwords are entered only on
Yoto's site. Do not share credentials or OAuth callback URLs with an assistant.

Ask the assistant to disconnect Yoto before removing the connection from its
settings. This deletes the connector's saved credentials for that connection;
it does not disconnect other assistants or revoke Yoto's app authorization.
Unused credentials expire after 30 days without a successful playlist read.
Operations already in progress may finish. See the [privacy page](https://yoto-connector.dev-simonlee.workers.dev/privacy).
