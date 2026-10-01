import { z } from "zod";
import type { AppEnv } from "./env";
import { randomId, sha256 } from "./security";

export const MAX_AUDIO = 50 * 1024 * 1024;
export const MAX_ICON = 60 * 1024;
export const uploadManifest = z.object({
  filename: z.string().min(1).max(120).regex(/^[a-zA-Z0-9 _().-]+$/),
  size: z.number().int().positive().max(MAX_AUDIO),
  mime: z.enum(["audio/mpeg", "audio/mp4", "audio/wav", "audio/flac", "audio/ogg"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type AudioMedia = { trackUrl: string; duration: number; fileSize: number; format: string; channels?: string | number };
export type UploadJob = { kind: "audio" | "icon"; secretHash: string; expires: number; state: "waiting" | "processing" | "ready" | "uncertain"; uploadId?: string; sourceHash?: string; polls?: number; lastPoll?: number; media?: AudioMedia; icon?: string };
export function validatePng(bytes: Uint8Array) {
  const sig = [137,80,78,71,13,10,26,10];
  if (bytes.length < 33 || bytes.length > MAX_ICON || !sig.every((b,i)=>bytes[i]===b)) throw new Error("Use a 16x16 RGBA PNG under 60 KiB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8)!==13 || view.getUint32(12)!==0x49484452 || view.getUint32(16)!==16 || view.getUint32(20)!==16 || bytes[24]!==8 || bytes[25]!==6) throw new Error("Use a 16x16 RGBA PNG");
}
export function uploadPage(): Response {
  const nonce=randomId();
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Upload to Yoto</title><style>body{font:18px/1.5 system-ui;max-width:38rem;margin:10vh auto;padding:24px}button,input{font:inherit;margin:12px 0}#status{white-space:pre-wrap}</style><main><h1>Upload to your Yoto account</h1><p>Choose audio you own or have permission to upload, or a 16×16 RGBA PNG icon. Audio goes directly to Yoto’s temporary upload destination. Icons pass through this connector. This step does not change a playlist.</p><input id="file" type="file"><br><button id="send">Upload selected file</button><p id="status" role="status"></p></main><script nonce="${nonce}">
const pieces=location.hash.slice(1).split('.');history.replaceState(null,'',location.pathname);
const status=document.getElementById('status'),file=document.getElementById('file'),button=document.getElementById('send');
const valid=pieces.length===3&&pieces.every(x=>/^[A-Za-z0-9_-]{43}$/.test(x));
const endpoint=valid?'/upload/'+pieces[0]+'/'+pieces[1]:'';
const headers={Authorization:'Upload '+pieces[2]};
async function call(suffix,opts={}){const r=await fetch(endpoint+suffix,{...opts,headers:{...headers,...opts.headers}});if(!r.ok)throw Error('Upload unavailable, expired or uncertain. Ask your assistant for status before trying again.');return r.json();}
if(!valid){button.disabled=true;status.textContent='Open the complete upload link from your assistant.';}
button.onclick=async()=>{button.disabled=true;try{const f=file.files[0];if(!f)throw Error('Choose a file first.');const info=await call('/info',{method:'POST'});
if(info.kind==='audio'){if(f.size>${MAX_AUDIO})throw Error('Audio limit: 50 MiB.');status.textContent='Preparing audio…';const bytes=await f.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');const result=await call('/audio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,size:f.size,mime:f.type,sha256:hash})});if(result.uploadUrl){const sent=await fetch(result.uploadUrl,{method:'PUT',headers:{'Content-Type':f.type},body:f,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});if(!sent.ok)throw Error('Audio upload failed. Ask your assistant to check status.');}}
else{if(f.size>${MAX_ICON})throw Error('Icon limit: 60 KiB.');await call('/icon',{method:'PUT',headers:{'Content-Type':'image/png'},body:f});}
status.textContent='Upload sent. Return to your assistant to check processing and preview where to attach it.';
}catch(e){status.textContent=e.message;}};
</script></html>`, {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Security-Policy":`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`}});
}
export async function uploadRoutes(request: Request, env: AppEnv): Promise<Response | null> {
  const path=new URL(request.url).pathname;
  if(path!=="/upload"&&!path.startsWith("/upload/"))return null;
  if(env.WRITES_ENABLED!=="true"||env.UPLOADS_ENABLED!=="true")return new Response("Uploads unavailable",{status:503});
  if(path==="/upload"&&request.method==="GET")return uploadPage();
  const match=/^\/upload\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})\/(info|audio|icon)$/.exec(path);
  if(!match||request.headers.get("Origin")!==env.PUBLIC_ORIGIN)return new Response("Invalid upload request",{status:403});
  const secret=request.headers.get("Authorization")?.match(/^Upload ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!secret)return new Response("Invalid upload request",{status:403});
  const connection=env.YOTO_CONNECTIONS.getByName(match[1]);
  try{
    const hash=await sha256(secret);
    let result:unknown;
    if(match[3]==="info"&&request.method==="POST")result=await connection.uploadInfo(match[2],hash);
    else if(match[3]==="audio"&&request.method==="POST")result=await connection.startAudioUpload(match[2],hash,await request.json());
    else if(match[3]==="icon"&&request.method==="PUT"&&request.headers.get("Content-Type")==="image/png")result=await connection.uploadIcon(match[2],hash,new Uint8Array(await request.arrayBuffer()));
    else return new Response("Invalid upload request",{status:400});
    return Response.json(result,{headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
  }catch{return Response.json({error:"Upload unavailable or outcome uncertain. Check status before starting another."},{status:400,headers:{"Cache-Control":"no-store"}});}
}
