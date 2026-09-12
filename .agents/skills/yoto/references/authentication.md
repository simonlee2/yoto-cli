# Authentication

## One-time setup

Create a public/native client at `https://dashboard.yoto.dev/` and register the
exact redirect URI:

```text
http://127.0.0.1:8787/callback
```

This OAuth client uses PKCE. It needs a public client ID and never a client
secret.

Provide the client ID to the process and start login:

```bash
YOTO_CLIENT_ID='<public-client-id>' yoto-cli login
```

Complete the browser flow on the same computer that is running the command so
the browser can reach the loopback listener. Keep the login process running
until it reports completion.

## Secrets boundary

The upstream CLI stores credentials in `~/.yoto-cli/config.json`. Keep that
file outside repositories and restrict it to the current user:

```bash
chmod 600 ~/.yoto-cli/config.json
```

Use `yoto-cli --json doctor` and `yoto-cli status` for diagnostics. Never read
or print the complete config file, and never ask the user to paste an OAuth
callback URL, authorization code, access token, refresh token, or client
secret into chat or a shell command.

If the callback cannot reach `127.0.0.1`, cancel the login and retry from a
browser on the same host. If port 8787 is occupied, identify and stop the local
listener only after confirming it is safe to do so, then retry.

After client settings or scopes change, log in again; an existing refresh token
does not acquire new permissions automatically.
