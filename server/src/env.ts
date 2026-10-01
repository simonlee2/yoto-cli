import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Bindings come from wrangler types; secrets and the provider-injected helper
// are runtime additions, not duplicate definitions of configured bindings.
export interface AppEnv extends Env {
  TOKEN_ENCRYPTION_KEY: string;
  OAUTH_PROVIDER: OAuthHelpers;
}
