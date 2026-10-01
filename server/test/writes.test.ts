import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../src/security";
import { changeSchema, transform } from "../src/writes";
const makeCard = () => ({ cardId: "owned", title: "Stories", content: { chapters: [{ key: "c1", title: "Chapter", tracks: [{ key: "t1", title: "First", trackUrl: "yoto:#audio1", duration: 10, custom: "preserve" }, { key: "t2", title: "Second", trackUrl: "yoto:#audio2", duration: 20 }], display: { icon16x16: "yoto:#icon" } }], playbackType: "linear", custom: "preserve" }, metadata: { description: "Before", author: "Keep" } });
let card: ReturnType<typeof makeCard>;
let writes: number;
let outbound: ReturnType<typeof vi.spyOn>;
let failure = "";
beforeEach(() => {
 card = makeCard(); writes = 0; failure = "";
 outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
  if (String(url).endsWith('/content/mine')) return Response.json({cards: init?.headers && (init.headers as Record<string,string>).Authorization === 'Bearer stranger' ? [] : [card]});
  if (String(url).endsWith('/content/owned')) return Response.json({card});
  if (String(url).endsWith('/content') && init?.method === 'POST') {
   writes++;
   if (failure === 'network') throw Error('secret upstream error');
   if (failure === 'malformed') return Response.json({private:'hidden'});
   if (failure !== 'ignored') card = {...JSON.parse(init.body as string),cardId:'owned'};
   if (failure === 'summary') return Response.json({card:{cardId:card.cardId}});
   if (failure === 'post-only-metadata') return Response.json({card:{...card,metadata:{...card.metadata,generatedReceipt:'synthetic'}}});
   if (failure === 'readback-loss') card.content.chapters[0].tracks.pop();
   return Response.json({card});
  }
  throw Error('Unexpected outbound request');
 });
});
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const coordinator=()=>env.MYO_WRITES.getByName('pilot');
async function reject(promise: PromiseLike<unknown>) { let rejected=false;try {await promise;}catch {rejected=true;}expect(rejected).toBe(true); }

describe('management previews and writes',()=>{
 it('previews without writes, encrypts intent, applies once and reads back',async()=>{
  const owner=randomId();const stub=coordinator();
  const preview=await stub.prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});
  expect(writes).toBe(0);expect(preview.targetTitle).toBe('Stories');
  await runInDurableObject(stub,async(_,state)=>{expect(JSON.stringify([...await state.storage.list()])).not.toContain('"New"');});
  const a=await stub.apply(owner,'test',preview.changeId);const b=await stub.apply(owner,'test',preview.changeId);
  expect(a).toEqual(b);expect(writes).toBe(1);expect(card.title).toBe('New');expect(card.metadata.author).toBe('Keep');expect(card.content.custom).toBe('preserve');
 });
 for (const responseShape of ['summary','post-only-metadata']) it(`verifies successful metadata update from authoritative GET with ${responseShape} POST`,async()=>{
  const owner=randomId(),stub=coordinator();const before=structuredClone(card.content);
  const preview=await stub.prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});
  failure=responseShape;
  const result=await stub.apply(owner,'test',preview.changeId);
  expect(result.cardId).toBe('owned');expect(card.content).toEqual(before);
  expect(await stub.apply(owner,'test',preview.changeId)).toEqual(result);expect(writes).toBe(1);
 });
 it('still rejects successful title updates with any missing track in readback',async()=>{
  const owner=randomId(),stub=coordinator();const preview=await stub.prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});
  failure='readback-loss';await reject(stub.apply(owner,'test',preview.changeId));
  expect(card.title).toBe('New');failure='';await reject(stub.apply(owner,'test',preview.changeId));expect(writes).toBe(1);
 });
 it('blocks cross-connection previews and lost ownership before any write',async()=>{
  const owner=randomId();const p=await coordinator().prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});
  await reject(coordinator().apply(randomId(),'test',p.changeId));
  await reject(coordinator().apply(owner,'stranger',p.changeId));expect(writes).toBe(0);
 });
 it('rejects stale previews, including competing connections',async()=>{
  const a=randomId(),b=randomId();const first=await coordinator().prepare(a,'test',{kind:'metadata',cardId:'owned',title:'A'});
  const second=await coordinator().prepare(b,'test',{kind:'metadata',cardId:'owned',title:'B'});
  const results=await Promise.allSettled([coordinator().apply(a,'test',first.changeId),coordinator().apply(b,'test',second.changeId)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(writes).toBe(1);
 });
 for(const problem of ['network','malformed','ignored']) it(`${problem} never automatically repeats an uncertain write`,async()=>{
  const owner=randomId();const p=await coordinator().prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});failure=problem;
  await reject(coordinator().apply(owner,'test',p.changeId));failure='';
  await reject(coordinator().apply(owner,'test',p.changeId));expect(writes).toBe(1);
 });
 it('creates a playlist once using a confirmed preview',async()=>{
  const owner=randomId();const p=await coordinator().prepare(owner,'test',{kind:'create',title:'New'});
  await coordinator().apply(owner,'test',p.changeId);await coordinator().apply(owner,'test',p.changeId);
  expect(writes).toBe(1);expect(card.content.chapters).toEqual([]);
 });
 it('rejects expired previews',async()=>{
  const owner=randomId();const stub=coordinator();const p=await stub.prepare(owner,'test',{kind:'metadata',cardId:'owned',title:'New'});
  await runInDurableObject(stub,async(_,state)=>{const r=await state.storage.get<Record<string,unknown>>(p.changeId);await state.storage.put(p.changeId,{...r,expires:0});});
  await reject(stub.apply(owner,'test',p.changeId));expect(writes).toBe(0);
 });
 it('connection entry refuses missing management scope and disconnect invalidates pending previews',async()=>{
  const id=randomId(), connection=env.YOTO_CONNECTIONS.getByName(id);
  await connection.initialize({accessToken:'test',refreshToken:'test',expiresAt:Date.now()+3600000});
  await reject(connection.prepareChange(id,{kind:'create',title:'Denied'}));expect(outbound).not.toHaveBeenCalled();
  const managerId=randomId(),manager=env.YOTO_CONNECTIONS.getByName(managerId);
  await manager.initialize({accessToken:'test',refreshToken:'test',expiresAt:Date.now()+3600000,scopes:['user:content:manage']});
  const p=await manager.prepareChange(managerId,{kind:'create',title:'New'}) as {changeId:string};
  await manager.disconnect();await reject(manager.applyChange(managerId,p.changeId));expect(writes).toBe(0);
 });
 it('refresh downscoping prevents a management write',async()=>{
  const owner=randomId(), connection=env.YOTO_CONNECTIONS.getByName(owner);
  await connection.initialize({accessToken:'old',refreshToken:'old',expiresAt:Date.now()-1,scopes:['user:content:manage']});
  outbound.mockImplementationOnce(async()=>Response.json({access_token:'new',refresh_token:'new',expires_in:3600,token_type:'Bearer',scope:'user:content:view'}));
  await reject(connection.prepareChange(owner,{kind:'create',title:'Denied'}));
  expect(outbound).toHaveBeenCalledTimes(1);expect(writes).toBe(0);
 });
 it('rejects copying audio from a playlist outside the account',async()=>{
  await reject(coordinator().prepare(randomId(),'test',{kind:'copy_track',cardId:'owned',chapterKey:'c1',sourceCardId:'someone-else',sourceChapterKey:'c1',sourceTrackKey:'t1'}));
  expect(writes).toBe(0);
 });
 it('removes precisely the selected track and exposes its title in preview',async()=>{
  const owner=randomId();const p=await coordinator().prepare(owner,'test',{kind:'remove_track',cardId:'owned',chapterKey:'c1',trackKey:'t2'});
  expect(p.affectedTrackTitle).toBe('Second');expect(p.destructive).toBe(true);
  await coordinator().apply(owner,'test',p.changeId);expect(card.content.chapters[0].tracks.map(t=>t.key)).toEqual(['t1']);
 });
});

describe('bounded surgical transformations',()=>{
 it('reorders exact permutations, rejects omissions and duplicates',()=>{
  const body=transform(changeSchema.parse({kind:'reorder_tracks',cardId:'owned',chapterKey:'c1',keys:['t2','t1']}),makeCard());
  expect(body.content.chapters[0].tracks.map(t=>t.key)).toEqual(['t2','t1']);
  for(const keys of [['t1'],['t1','t1'],['t1','unknown']])expect(()=>transform(changeSchema.parse({kind:'reorder_tracks',cardId:'owned',chapterKey:'c1',keys}),makeCard())).toThrow();
 });
 it('updates chapter and first-track icons together, preserving other tracks',()=>{
  const body=transform(changeSchema.parse({kind:'chapter_icon',cardId:'owned',chapterKey:'c1',icon:'yoto:#new'}),makeCard());
  expect(body.content.chapters[0].display).toEqual({icon16x16:'yoto:#new'});expect(body.content.chapters[0].tracks[0].display).toEqual({icon16x16:'yoto:#new'});expect(body.content.chapters[0].tracks[1].display).toBeUndefined();
 });
 it('copies owned durable audio with a fresh key and rejects external URLs',()=>{
  const change=changeSchema.parse({kind:'copy_track',cardId:'owned',chapterKey:'c1',sourceCardId:'owned',sourceChapterKey:'c1',sourceTrackKey:'t1'});
  const body=transform(change,makeCard(),makeCard());expect(body.content.chapters[0].tracks).toHaveLength(3);expect(body.content.chapters[0].tracks[2].key).not.toBe('t1');
  const external=makeCard();external.content.chapters[0].tracks[0].trackUrl='https://private.example/audio';expect(()=>transform(change,makeCard(),external)).toThrow();
 });
 it('rejects unknown fields, injection paths and whole-playlist deletion',()=>{
  for(const input of [{kind:'delete',cardId:'owned'},{kind:'metadata',cardId:'../other',title:'x'},{kind:'create',title:'x',userId:'someone'}])expect(changeSchema.safeParse(input).success).toBe(false);
 });
});
