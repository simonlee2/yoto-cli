# Self-hosting the Yoto connector

Requires Node.js 22+, a Cloudflare account supporting Workers, KV and SQLite
Durable Objects, and a Yoto public PKCE app. Review your account limits before
creating resources. This guide does not require paid services or a Yoto client secret.

## Local development

```sh
cd server
npm ci --legacy-peer-deps
npm run types
npm run typecheck
npm test
npm run build
```

The build is a deployment dry-run. Tests use synthetic identities and mock Yoto.
Copy `.dev.vars.example` to `.dev.vars` for local development. Use a dedicated
Yoto app with `http://localhost:8787/oauth/yoto/callback` registered; run
`npm run dev`. Never commit credentials or use production tokens in tests.

## Configure your deployment

Copy `wrangler.jsonc` to ignored `wrangler.local.jsonc`. Use this config explicitly
for operator commands, for example `npx wrangler deploy --config wrangler.local.jsonc`.
The template contains placeholder IDs and disables enrollment, writes and uploads.

1. Authenticate Wrangler to your account. Choose a permanent HTTPS Worker origin.
2. Create an OAuth KV namespace and put its ID in the local config. Set your own
   account ID if needed. The config declares the SQLite Durable Object migrations.
3. Set `PUBLIC_ORIGIN` to the HTTPS origin without a trailing slash.
4. Register `PUBLIC_ORIGIN/oauth/yoto/callback` in your Yoto public app and set
   its public ID as `YOTO_CLIENT_ID`. Enable content viewing and offline access;
   management additionally needs `user:content:manage`. Do not add device/family scopes.
5. Configure a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY` using Wrangler's
   secret entry or the Cloudflare dashboard, without printing or committing it.
   Keep this key stable; rotating it requires a credential-storage migration.
6. Deploy using the local config. Enable `ENROLLMENT_ENABLED=true` when ready
   for users to authorize. Connect clients at `PUBLIC_ORIGIN/mcp`.

Management requires `WRITES_ENABLED=true` and each user's explicit grant.
Uploads require BOTH `WRITES_ENABLED=true` and `UPLOADS_ENABLED=true`.
Keep uploads disabled for a playlist-editing-only service.

## Operational constraints

Tokens are encrypted per connection. Only a successful validated playlist read
renews the 30-day retention deadline; disconnect deletes saved credentials but
not Yoto's upstream app authorization. Refreshes are serialized and uncertain
single-use-token outcomes require reconnecting rather than retries.

Write previews expire in ten minutes; receipts in 24 hours. Writes recheck
ownership/revision and validate a fresh readback. Yoto has no documented atomic
conditional-update guarantee: avoid concurrent edits in other clients. An uncertain
write must be inspected before preparing another change. No whole-playlist delete
is exposed. The single write coordinator is suited to a small service.

Rate limits are per Cloudflare location, not a global spending cap. Logging and
tracing are disabled to avoid collecting OAuth URLs or credentials. Do not enable
them without reviewing dependency logging and redaction.

Upload support is gated separately. Before enabling it, validate signed-URL CORS,
upstream file-size limits, actual transcode response shapes and client file handoff.
The browser's size check is not a trusted upstream byte limit. Previously issued
signed URLs and requests in flight cannot be revoked by pausing uploads.

Client setup: [connector guide](README.md). Provider references:
[Yoto browser auth](https://yoto.dev/authentication/browser-auth/),
[Cloudflare Workers](https://developers.cloudflare.com/workers/),
[ChatGPT authentication](https://developers.openai.com/plugins/build/auth).
