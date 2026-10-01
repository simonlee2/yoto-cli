import {env,exports} from 'cloudflare:workers';
import {reset,runInDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {randomId,sha256,unseal,seal} from '../src/security';
import {type UploadJob,validatePng} from '../src/uploads';
const origin='https://connector.test';
let outbound:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{outbound=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unexpected network'));});
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const manifest={filename:'story.mp3',size:1000,mime:'audio/mpeg',sha256:'a'.repeat(64)};
async function session(kind:'audio'|'icon'='audio'){
 const id=randomId(),connection=env.YOTO_CONNECTIONS.getByName(id);
 await connection.initialize({accessToken:'mock',refreshToken:'mock',expiresAt:Date.now()+3600000,scopes:['user:content:manage']});
 const upload=await connection.beginUpload(id,kind);
 const secret=new URL(upload.url).hash.slice(1).split('.')[2];
 return {id,connection,upload,secret,hash:await sha256(secret)};
}
function png(){const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10]);const v=new DataView(bytes.buffer);v.setUint32(8,13);v.setUint32(12,0x49484452);v.setUint32(16,16);v.setUint32(20,16);bytes[24]=8;bytes[25]=6;return bytes;}
async function rejected(p:PromiseLike<unknown>){let no=false;try{await p;}catch{no=true;}expect(no).toBe(true);}
async function route(s:Awaited<ReturnType<typeof session>>,action:string,body?:BodyInit,originHeader=origin){return exports.default.fetch(`${origin}/upload/${s.id}/${s.upload.jobId}/${action}`,{method:action==='icon'?'PUT':'POST',headers:{Host:'connector.test',Origin:originHeader,Authorization:`Upload ${s.secret}`,'Content-Type':action==='icon'?'image/png':'application/json'},body});}

describe('private upload handoff',()=>{
 it('does not call Yoto until the user submits a file and excludes secrets from server URL',async()=>{
  const s=await session();expect(outbound).not.toHaveBeenCalled();expect(new URL(s.upload.url).pathname).toBe('/upload');expect(new URL(s.upload.url).search).toBe('');
  expect(await s.connection.uploadInfo(s.upload.jobId,s.hash)).toEqual({kind:'audio',state:'waiting'});
  const page=await exports.default.fetch(origin+'/upload',{headers:{Host:'connector.test'}});expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');expect(await page.text()).not.toContain(s.secret);
 });
 it('rejects wrong capabilities, cross-connection job IDs and cross-origin posts',async()=>{
  const a=await session(),b=await session();await rejected(a.connection.uploadInfo(a.upload.jobId,'wrong'));await rejected(b.connection.uploadStatus(a.upload.jobId));
  expect((await route(a,'audio',JSON.stringify(manifest),'https://attacker.test')).status).toBe(403);expect(outbound).not.toHaveBeenCalled();
 });
 it('creates one audio destination, polls matching results and keeps signed URLs/tokens out of MCP status',async()=>{
  const s=await session();outbound.mockImplementationOnce(async()=>Response.json({upload:{uploadId:'up1',uploadUrl:'https://uploads.example.test/signed?secret=private'}}));
  const r=await route(s,'audio',JSON.stringify(manifest));expect(r.status).toBe(200);expect(await r.json()).toMatchObject({uploadUrl:expect.any(String)});
  await rejected(s.connection.startAudioUpload(s.upload.jobId,s.hash,manifest));
  outbound.mockImplementationOnce(async()=>Response.json({transcode:{uploadId:'up1',uploadSha256:manifest.sha256,transcodedSha256:'audio-hash',transcodedInfo:{duration:5,fileSize:100,format:'mp3',private:'hidden'}}}));
  const status=await s.connection.uploadStatus(s.upload.jobId);expect(status).toMatchObject({state:'ready',readyToAttach:true,duration:5});expect(JSON.stringify(status)).not.toMatch(/signed|private|mock/);
 });
 it('rejects bad manifests and non-HTTPS destinations without exposing credentials',async()=>{
  const s=await session();await rejected(s.connection.startAudioUpload(s.upload.jobId,s.hash,{...manifest,filename:'../secret'}));expect(outbound).not.toHaveBeenCalled();
  outbound.mockImplementationOnce(async()=>Response.json({upload:{uploadId:'up1',uploadUrl:'http://localhost/private'}}));await rejected(s.connection.startAudioUpload(s.upload.jobId,s.hash,manifest));
  expect(await s.connection.uploadStatus(s.upload.jobId)).toEqual({state:'uncertain'});
 });
 it('uploads validated PNG once and returns only its durable icon reference',async()=>{
  const s=await session('icon');outbound.mockImplementationOnce(async(url,init)=>{expect(String(url)).toContain('/media/displayIcons/user/me/upload?autoConvert=false');expect(init?.body).toBeInstanceOf(FormData);return Response.json({displayIcon:{mediaId:'iconhash',userId:'private',url:'https://private'}});});
  expect((await route(s,'icon',png())).status).toBe(200);await rejected(s.connection.uploadIcon(s.upload.jobId,s.hash,png()));
  expect(await s.connection.uploadStatus(s.upload.jobId)).toEqual({state:'ready',icon:'yoto:#iconhash'});expect(outbound).toHaveBeenCalledTimes(1);
 });
 it('validates icon dimensions, format and bounded body before upload',async()=>{
  const s=await session('icon');const wrong=png();wrong[19]=32;expect(()=>validatePng(wrong)).toThrow();
  await rejected(s.connection.uploadIcon(s.upload.jobId,s.hash,new Uint8Array(70000)));expect((await route(s,'icon',new Uint8Array(70000))).status).toBe(413);expect(outbound).not.toHaveBeenCalled();
 });
 it('disconnect and expiry invalidate capabilities and cleanup erases job data',async()=>{
  const s=await session();await s.connection.disconnect();await rejected(s.connection.uploadInfo(s.upload.jobId,s.hash));
  const next=await session();await runInDurableObject(next.connection,async(_,state)=>{const key='upload:'+next.upload.jobId;const job=await unseal<UploadJob>(state.storage.kv.get<string>(key)!,env.TOKEN_ENCRYPTION_KEY);job.expires=0;state.storage.kv.put(key,await seal(job,env.TOKEN_ENCRYPTION_KEY));});
  await rejected(next.connection.uploadStatus(next.upload.jobId));await runDurableObjectAlarm(next.connection);
  await runInDurableObject(next.connection,async(_,state)=>expect((await state.storage.list({prefix:'upload:'})).size).toBe(0));
 });
 it('enforces daily job quota without external requests',async()=>{
  const s=await session();for(let i=1;i<20;i++)await s.connection.beginUpload(s.id,'audio');await rejected(s.connection.beginUpload(s.id,'audio'));expect(outbound).not.toHaveBeenCalled();
 });
 it('cannot attach another connection’s upload and only prepares ready audio',async()=>{
  const a=await session(),b=await session();const change={kind:'attach_audio',cardId:'owned',chapterKey:'c',uploadJobId:a.upload.jobId,title:'Track',icon:'yoto:#icon'};
  await rejected(b.connection.prepareChange(b.id,change));await rejected(a.connection.prepareChange(a.id,change));expect(outbound).not.toHaveBeenCalled();
 });
 it('checks transcode job and original hash rather than accepting arbitrary media',async()=>{
  const s=await session();outbound.mockImplementationOnce(async()=>Response.json({upload:{uploadId:'up1',uploadUrl:null}}));await s.connection.startAudioUpload(s.upload.jobId,s.hash,manifest);
  outbound.mockImplementationOnce(async()=>Response.json({transcode:{uploadId:'another',uploadSha256:manifest.sha256,transcodedSha256:'hash',transcodedInfo:{duration:1,fileSize:1,format:'mp3'}}}));await rejected(s.connection.uploadStatus(s.upload.jobId));
 });
});

describe('new audio attachment',()=>{
 async function ready(){const s=await session();outbound.mockImplementationOnce(async()=>Response.json({upload:{uploadId:'up',uploadUrl:null}}));await s.connection.startAudioUpload(s.upload.jobId,s.hash,manifest);outbound.mockImplementationOnce(async()=>Response.json({transcode:{uploadId:'up',uploadSha256:manifest.sha256,transcodedSha256:'audiohash',transcodedInfo:{duration:5,fileSize:1000,format:'mp3'}}}));await s.connection.uploadStatus(s.upload.jobId);return s;}
 function mockPlaylist(){let card:any={cardId:'owned',title:'Playlist',content:{chapters:[{key:'c',title:'Chapter',tracks:[]}]},metadata:{}};outbound.mockImplementation(async(url,init)=>{if(String(url).endsWith('/content/mine'))return Response.json({cards:[card]});if(init?.method==='POST'){card=JSON.parse(init.body as string);return Response.json({card});}return Response.json({card});});return ()=>card;}
 it('attaches verified uploaded audio only after a separate preview',async()=>{
  const s=await ready(),getCard=mockPlaylist();const preview=await s.connection.prepareChange(s.id,{kind:'attach_audio',cardId:'owned',chapterKey:'c',uploadJobId:s.upload.jobId,title:'New track',icon:'yoto:#icon'}) as {changeId:string};
  expect(getCard().content.chapters[0].tracks).toEqual([]);await s.connection.applyChange(s.id,preview.changeId);
  expect(getCard().content.chapters[0].tracks[0]).toMatchObject({title:'New track',trackUrl:'yoto:#audiohash',duration:5,fileSize:1000,display:{icon16x16:'yoto:#icon'}});
 });
 it('cancellation invalidates prepared attachment without a playlist write',async()=>{
  const s=await ready(),getCard=mockPlaylist();const preview=await s.connection.prepareChange(s.id,{kind:'attach_audio',cardId:'owned',chapterKey:'c',uploadJobId:s.upload.jobId,title:'New track',icon:'yoto:#icon'}) as {changeId:string};
  await s.connection.cancelUpload(s.upload.jobId);await rejected(s.connection.applyChange(s.id,preview.changeId));expect(getCard().content.chapters[0].tracks).toEqual([]);
 });
});
