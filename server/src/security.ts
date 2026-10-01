export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function publicOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost"))) {
    throw new Error("Invalid public origin");
  }
  return url.origin;
}

export async function seal(value: unknown, encodedKey: string): Promise<string> {
  const key = await encryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) });
}

export async function unseal<T>(value: string, encodedKey: string): Promise<T> {
  const { iv, data } = JSON.parse(value);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, await encryptionKey(encodedKey), new Uint8Array(data));
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function validateEncryptionKey(value: string): Promise<void> {
  await encryptionKey(value);
}

async function encryptionKey(value: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("Invalid encryption key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Bound bodies before parsing; never include upstream response bodies in errors. */
export async function boundedJson(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Upstream request failed");
  return JSON.parse(await boundedText(response.body, maxBytes));
}

export async function boundedText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Upstream response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(body);
}
