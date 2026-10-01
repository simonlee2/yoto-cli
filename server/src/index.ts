import { uploadRoutes } from "./uploads";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { authRoutes, CONNECTOR_SCOPE, WRITE_SCOPE, safeResponse } from "./auth";
import { mcp } from "./mcp";
import { publicOrigin } from "./security";
import { guardRequest } from "./limits";
import type { AppEnv } from "./env";
export { MyoWrites } from "./writes";
export { AuthFlow, YotoConnection } from "./storage";

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const origin = publicOrigin(env.PUBLIC_ORIGIN);
      if (new URL(request.url).origin !== origin) return safeResponse("Invalid host.", 421);
      if (new URL(request.url).pathname === "/health") {
        return Response.json({ ready: !!env.YOTO_CLIENT_ID && !!env.TOKEN_ENCRYPTION_KEY }, { headers: { "Cache-Control": "no-store" } });
      }
      const guarded = await guardRequest(request, env);
      if (guarded instanceof Response) return guarded;
      request = guarded;
      const upload = await uploadRoutes(request, env);
      if (upload) return upload;
      const provider = new OAuthProvider<AppEnv>({
        apiRoute: "/mcp", apiHandler: { fetch: mcp }, defaultHandler: { fetch: authRoutes },
        authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register",
        scopesSupported: env.WRITES_ENABLED === "true" ? [CONNECTOR_SCOPE, WRITE_SCOPE] : [CONNECTOR_SCOPE], allowImplicitFlow: false, allowPlainPKCE: false,
        accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 60 * 60, clientRegistrationTTL: 90 * 24 * 60 * 60,
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: env.WRITES_ENABLED === "true" ? [CONNECTOR_SCOPE, WRITE_SCOPE] : [CONNECTOR_SCOPE], resource_name: "Yoto MYO connector" },
        onError: ({ code, status, headers }) => Response.json({ error: code, error_description: "Invalid OAuth request. Start again from your assistant." }, { status, headers: { ...headers, "Cache-Control": "no-store" } })
      });
      return await provider.fetch(request, env, ctx);
    } catch {
      // No exception strings, URLs, authorization codes or tokens in logs.
      return safeResponse("Request could not be completed. Start again from your assistant.", 400);
    }
  }
} satisfies ExportedHandler<AppEnv>;
