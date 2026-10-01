import {env} from 'cloudflare:workers';
import {createExecutionContext,reset,runInDurableObject} from 'cloudflare:test';
import {afterEach,it,expect,vi} from 'vitest';
import {uploadRoutes} from '../src/uploads';
import {mcp} from '../src/mcp';
import {randomId} from '../src/security';
import type {AppEnv} from '../src/env';
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const origin='https://connector.test';
it.each([undefined,'false','TRUE'])('blocks upload HTTP routes with management enabled and upload flag %s',async flag=>{
 const config={...env,WRITES_ENABLED:'true',UPLOADS_ENABLED:flag} as unknown as AppEnv;
 for(const path of ['/upload','/upload/'+randomId()+'/'+randomId()+'/audio']) expect((await uploadRoutes(new Request(origin+path),config))?.status).toBe(503);
});
it.each([['true','false',6],['true',undefined,6],['false','true',4],['true','true',9]])('advertises correct tools for writes=%s uploads=%s',async(writes,uploads,count)=>{
 const ctx=createExecutionContext();ctx.props={connectionId:randomId(),scopes:['myo:read','myo:write']};
 const config={...env,WRITES_ENABLED:writes,UPLOADS_ENABLED:uploads,OAUTH_PROVIDER:{unwrapToken:async()=>({scope:['myo:read','myo:write']})}} as unknown as AppEnv;
 const response=await mcp(new Request(origin+'/mcp',{method:'POST',headers:{Host:'connector.test',Authorization:'Bearer synthetic','Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),config,ctx);
 const text=await response.text();const payload=JSON.parse(text.startsWith('event:')?text.split('\n').find(x=>x.startsWith('data: '))!.slice(6):text);
 expect(payload).toHaveProperty("result.tools");
 expect(payload.result.tools).toHaveLength(Number(count));
 expect(payload.result.tools.some((t:{name:string})=>t.name==='begin_myo_upload')).toBe(writes==='true'&&uploads==='true');
 expect(payload.result.tools.some((t:{name:string})=>t.name==='prepare_myo_change')).toBe(writes==='true');
});
it('blocks direct upload RPCs and pending attachment operations after upload pause',async()=>{
 const outbound=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
 const id=randomId(),connection=env.YOTO_CONNECTIONS.getByName(id);
 await connection.initialize({accessToken:'synthetic',refreshToken:'synthetic',expiresAt:Date.now()+3600000,scopes:['user:content:manage']});
 const job=await connection.beginUpload(id,'audio');
 await runInDurableObject(connection,async(object,state)=>{
  const changeId=randomId();state.storage.kv.put(`attachment:${changeId}`,{jobId:job.jobId,expires:Date.now()+60000});
  const bindings=(object as unknown as {env:AppEnv}).env;const prior=bindings.UPLOADS_ENABLED;
  try {
   bindings.UPLOADS_ENABLED='false';
   for(const operation of [()=>object.beginUpload(id,'audio'),()=>object.uploadInfo(job.jobId,'synthetic'),()=>object.uploadStatus(job.jobId),()=>object.startAudioUpload(job.jobId,'synthetic',{}),()=>object.uploadIcon(job.jobId,'synthetic',new Uint8Array()),()=>object.cancelUpload(job.jobId),()=>object.applyChange(id,changeId),()=>object.prepareChange(id,{kind:'attach_audio',uploadJobId:job.jobId})]) {
    let rejected=false;try{await operation()}catch{rejected=true}expect(rejected).toBe(true);
   }
  } finally {bindings.UPLOADS_ENABLED=prior;}
 });
 expect(outbound).not.toHaveBeenCalled();
 expect(await connection.status()).toEqual({connected:true});
});
