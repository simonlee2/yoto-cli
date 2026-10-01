import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeTokens, TokenExchangeError } from "../src/yoto";
import { base64url } from "../src/security";
const jwt = (claims: unknown) => `e30.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}.synthetic`;
afterEach(() => vi.restoreAllMocks());
function respond(body: unknown) { return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => { new Request(input, init); return Response.json(body); }); }
describe("Yoto documented token formats", () => {
  it("accepts the documented two-token response and uses JWT exp only for expiry", async () => {
    const exp = Math.floor(Date.now()/1000) + 3600;
    const fetcher = respond({ access_token: jwt({ exp, scope: "user:content:manage", sub: "synthetic" }), refresh_token: "synthetic-refresh" });
    const result = await exchangeTokens({ grant_type: "authorization_code", code: "synthetic+code&value", code_verifier: "synthetic-verifier", client_id: "test", redirect_uri: "https://connector.test/oauth/yoto/callback" });
    expect(result.expiresAt).toBe(exp*1000);
    expect(result.scopes).toBeUndefined();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://login.yotoplay.com/oauth/token");
    expect(new Headers(init!.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(init!.body as string).get("code")).toBe("synthetic+code&value");
    expect(init!.redirect).toBe("manual");
  });
  it("preserves standard OAuth responses with opaque access tokens", async () => {
    respond({access_token:"opaque",refresh_token:"rotated",expires_in:3600,token_type:"Bearer",scope:"user:content:view"});
    expect(await exchangeTokens({grant_type:"refresh_token",refresh_token:"synthetic"})).toMatchObject({accessToken:"opaque",refreshToken:"rotated",scopes:["user:content:view"]});
  });
  it.each([{}, {exp:"123"}, {exp:0}, {exp:Date.now()/1000+40_000_000}])("rejects unusable JWT expiry %j", async claims => {
    respond({access_token:jwt(claims),refresh_token:"synthetic"});
    await expect(exchangeTokens({grant_type:"authorization_code"})).rejects.toThrow("Yoto token exchange: expiry http-200");
  });
  it.each([
    {access_token:"opaque",refresh_token:"synthetic"},
    {access_token:jwt({exp:Date.now()/1000+3600})},
    {access_token:"opaque",refresh_token:"synthetic",expires_in:3600,token_type:"Other"},
    {access_token:"opaque",refresh_token:"synthetic",expires_in:0}
  ])("rejects malformed or incomplete tokens", async body => {
    respond(body);await expect(exchangeTokens({grant_type:"authorization_code"})).rejects.toThrow();
  });
});

describe("bounded token diagnostics", () => {
  it.each([
    { status:400, body:{error:"invalid_grant",error_description:"private-code-and-token"}, expected:"http http-400 invalid_grant" },
    { status:401, body:{error:"invalid_client",error_description:"private-code-and-token"}, expected:"http http-401 invalid_client" },
    { status:400, body:{error:"<script>private-code-and-token</script>"}, expected:"http http-400" },
    { status:200, body:{access_token:"private-code-and-token",expires_in:3600}, expected:"schema http-200 refresh_token" },
    { status:200, body:{access_token:"private-code-and-token",refresh_token:"private-code-and-token",expires_in:3600,scope:"unapproved"}, expected:"permission http-200" }
  ])("reports only safe categories: $expected", async ({status,body,expected}) => {
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>Response.json(body,{status}));
    try { await exchangeTokens({grant_type:"authorization_code",code:"private-code-and-token"}); throw new Error("Expected rejection"); }
    catch(error) {
      expect(error).toBeInstanceOf(TokenExchangeError);
      expect((error as TokenExchangeError).diagnostic).toBe(expected);
      expect(String(error)).not.toContain("private-code-and-token");
      expect(String(error)).not.toContain("<script>");
    }
  });
  it.each([
    { status:200, text:"not JSON private-token", expected:"json http-200" },
    { status:502, text:"upstream private-token", expected:"http http-502" },
    { status:200, text:"x".repeat(64001), expected:"body http-200" },
    { status:429, text:"x".repeat(64001), expected:"http http-429" }
  ])("bounds invalid bodies: $expected", async ({status,text,expected}) => {
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(text,{status}));
    await expect(exchangeTokens({grant_type:"authorization_code"})).rejects.toMatchObject({diagnostic:expected});
  });
  it("sanitizes transport exceptions", async () => {
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("private network URL/code"));
    await expect(exchangeTokens({grant_type:"authorization_code"})).rejects.toMatchObject({message:"Yoto token exchange: network",diagnostic:"network"});
  });
});

describe("token redirect boundary", () => {
  it.each([301,302,303,307,308])("rejects HTTP %i without following or accepting tokens", async status => {
    const fetcher = vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      // Use the real Worker Request constructor so unsupported fetch options fail the test.
      const request = new Request(input,init);
      expect(request.redirect).toBe("manual");
      return Response.json({access_token:"synthetic",refresh_token:"synthetic",expires_in:3600},{status,headers:{Location:"https://untrusted.test/"}});
    });
    await expect(exchangeTokens({grant_type:"authorization_code",code:"synthetic"})).rejects.toMatchObject({diagnostic:`http http-${status}`});
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
