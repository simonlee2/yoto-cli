import { DurableObject } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./env";
import { uploadManifest, validatePng, MAX_AUDIO, type UploadJob, type AudioMedia } from "./uploads";
import { z } from "zod";
import { boundedJson, seal, unseal, randomId, sha256 } from "./security";
import { cardsSchema, cardSchema, exchangeTokens, type Tokens } from "./yoto";

export type Flow = {
  request: AuthRequest; browserHash: string; verifier: string;
  expiresAt: number; stage: "consent" | "yoto";
};

export class AuthFlow extends DurableObject<AppEnv> {
  async create(flow: Flow): Promise<void> {
    if (this.ctx.storage.kv.get("flow")) throw new Error("Flow already exists");
    this.ctx.storage.kv.put("flow", flow);
    await this.ctx.storage.setAlarm(flow.expiresAt);
  }

  async approve(browserHash: string): Promise<Flow | null> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (!flow || flow.browserHash !== browserHash || flow.expiresAt <= Date.now() || flow.stage !== "consent") return null;
    flow.stage = "yoto";
    this.ctx.storage.kv.put("flow", flow);
    return flow;
  }

  async consume(browserHash: string): Promise<Flow | null> {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    if (!flow || flow.browserHash !== browserHash || flow.expiresAt <= Date.now() || flow.stage !== "yoto") return null;
    this.ctx.storage.kv.delete("flow");
    return flow;
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export class YotoConnection extends DurableObject<AppEnv> {
  private queue: Promise<unknown> = Promise.resolve();

  // Serialize RPCs, including external requests, without holding an input gate.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async initialize(tokens: Tokens): Promise<void> {
    return this.serial(async () => {
      if (this.ctx.storage.kv.get("initialized")) throw new Error("Already initialized");
      const encrypted = await seal(tokens, this.env.TOKEN_ENCRYPTION_KEY);
      this.ctx.storage.kv.put("initialized", true);
      this.ctx.storage.kv.put("tokens", encrypted);
      await this.touch();
    });
  }

  async status(): Promise<{ connected: boolean }> {
    return this.serial(async () => ({ connected: this.hasCredentials() }));
  }

  async managementPermission(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.hasCredentials()) return false;
      const tokens = await unseal<Tokens>(this.ctx.storage.kv.get<string>("tokens")!, this.env.TOKEN_ENCRYPTION_KEY);
      return tokens.scopes?.includes("user:content:manage") === true;
    });
  }

  async disconnect(): Promise<void> {
    return this.serial(async () => {
      this.ctx.storage.kv.delete("tokens");
      this.ctx.storage.kv.delete("refreshing");
      for (const prefix of ["upload:", "attachment:"]) for (const key of (await this.ctx.storage.list({prefix})).keys()) await this.ctx.storage.delete(key);
      // Retain the tombstone until cleanup so late calls cannot reinitialize.
      await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
    });
  }

  async list(): Promise<ReturnType<typeof cardsSchema.parse>> {
    return this.serial(async () => {
      const cards = cardsSchema.parse(await this.api("/content/mine"));
      await this.touch();
      return cards;
    });
  }

  async get(cardId: string): Promise<ReturnType<typeof cardSchema.parse>> {
    return this.serial(async () => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cardId)) throw new Error("Invalid card ID");
      const owned = cardsSchema.parse(await this.api("/content/mine"));
      if (!owned.cards.some(card => card.cardId === cardId)) throw new Error("Playlist is not owned by this connection");
      const result = await this.api(`/content/${encodeURIComponent(cardId)}`);
      // Yoto's detail endpoint wraps the card in { card: ... }.
      const card = cardSchema.parse((result as { card?: unknown }).card);
      if (card.cardId !== cardId) throw new Error("Unexpected playlist");
      await this.touch();
      return card;
    });
  }

  async prepareChange(connectionId: string, input: unknown): Promise<unknown> {
    return this.serial(async () => {
      const token = await this.writeToken();
      const change = input as { kind?: string; uploadJobId?: string };
      let media: AudioMedia | undefined;
      if(change.kind === "attach_audio") { const job=await this.job(change.uploadJobId!); if(job.state!=="ready"||!job.media)throw new Error("Audio not ready");media=job.media; }
      const preview=await this.env.MYO_WRITES.getByName("pilot").prepare(connectionId, token, input, media);
      if(change.kind==="attach_audio") this.ctx.storage.kv.put(`attachment:${preview.changeId}`,{jobId:change.uploadJobId,expires:Date.now()+86400000});
      return preview;
    });
  }

  async applyChange(connectionId: string, changeId: string): Promise<unknown> {
    return this.serial(async () => {
      const token = await this.writeToken();
      const attachment=this.ctx.storage.kv.get<{jobId:string;expires:number}>(`attachment:${changeId}`);
      if(attachment){if(attachment.expires<=Date.now())throw new Error("Preview expired");await this.job(attachment.jobId);}
      const result = await this.env.MYO_WRITES.getByName("pilot").apply(connectionId, token, changeId);
      await this.touch();
      return result;
    });
  }

  private requireUploads(): void {
    if (this.env.WRITES_ENABLED !== "true" || this.env.UPLOADS_ENABLED !== "true") throw new Error("Uploads disabled");
  }

  async beginUpload(connectionId: string, kind: "audio" | "icon") {
    return this.serial(async () => {
      this.requireUploads();
      await this.writeToken();
      if (!/^[A-Za-z0-9_-]{43}$/.test(connectionId) || !["audio", "icon"].includes(kind)) throw new Error("Invalid upload");
      const day = Math.floor(Date.now() / 86_400_000);
      const quota = this.ctx.storage.kv.get<{day:number;count:number}>("upload-quota");
      if (quota?.day === day && quota.count >= 20) throw new Error("Daily upload limit");
      this.ctx.storage.kv.put("upload-quota", {day,count:quota?.day===day?quota.count+1:1});
      const jobId=randomId(),secret=randomId(),expires=Date.now()+30*60_000;
      await this.saveJob(jobId,{kind,secretHash:await sha256(secret),expires,state:"waiting"});
      return {jobId,url:`${this.env.PUBLIC_ORIGIN}/upload#${connectionId}.${jobId}.${secret}`,expiresAt:new Date(expires).toISOString(),instruction:"Open this private link yourself and select a file. Do not share the link. Upload does not attach media to a playlist."};
    });
  }
  private async job(jobId:string, hash?:string):Promise<UploadJob> {
    this.requireUploads();
    if(!/^[A-Za-z0-9_-]{43}$/.test(jobId))throw new Error("Invalid job");
    if(!this.hasCredentials())throw new Error("Reconnect");
    const stored=this.ctx.storage.kv.get<string>(`upload:${jobId}`);
    if(!stored)throw new Error("Missing upload");
    const job=await unseal<UploadJob>(stored,this.env.TOKEN_ENCRYPTION_KEY);
    if(job.expires<=Date.now()||(hash!==undefined&&hash!==job.secretHash))throw new Error("Expired or invalid upload");
    return job;
  }
  private async saveJob(id:string,job:UploadJob) {
    this.ctx.storage.kv.put(`upload:${id}`,await seal(job,this.env.TOKEN_ENCRYPTION_KEY));
    const current=await this.ctx.storage.getAlarm();
    if(current===null||current>job.expires)await this.ctx.storage.setAlarm(job.expires);
  }
  async uploadInfo(id:string,hash:string) {return this.serial(async()=>{const job=await this.job(id,hash);await this.writeToken();return {kind:job.kind,state:job.state};});}
  async startAudioUpload(id:string,hash:string,input:unknown) {
    return this.serial(async()=>{
      const job=await this.job(id,hash);const token=await this.writeToken();
      if(job.kind!=="audio"||job.state!=="waiting")throw new Error("Upload already started");
      const manifest=uploadManifest.parse(input);
      job.state="uncertain";job.sourceHash=manifest.sha256;await this.saveJob(id,job);await this.ctx.storage.sync();
      const response=await fetch(`https://api.yotoplay.com/media/transcode/audio/uploadUrl?${new URLSearchParams({sha256:manifest.sha256,filename:manifest.filename})}`,{headers:{Authorization:`Bearer ${token}`},redirect:"manual",signal:AbortSignal.timeout(15000)});
      const data=z.object({upload:z.object({uploadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),uploadUrl:z.string().url().nullable()})}).parse(await boundedJson(response));
      if(data.upload.uploadUrl){const url=new URL(data.upload.uploadUrl);if(url.protocol!=="https:"||url.username||url.password)throw new Error("Invalid upload destination");}
      job.uploadId=data.upload.uploadId;job.state="processing";await this.saveJob(id,job);
      return {uploadUrl:data.upload.uploadUrl};
    });
  }
  async uploadIcon(id:string,hash:string,bytes:Uint8Array) {
    return this.serial(async()=>{
      const job=await this.job(id,hash);const token=await this.writeToken();
      if(job.kind!=="icon"||job.state!=="waiting")throw new Error("Upload already started");
      validatePng(bytes);job.state="uncertain";await this.saveJob(id,job);await this.ctx.storage.sync();
      const form=new FormData();form.append("file",new Blob([bytes],{type:"image/png"}),"icon.png");
      const response=await fetch("https://api.yotoplay.com/media/displayIcons/user/me/upload?autoConvert=false&filename=icon",{method:"POST",headers:{Authorization:`Bearer ${token}`},body:form,redirect:"manual",signal:AbortSignal.timeout(15000)});
      const data=z.object({displayIcon:z.object({mediaId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)})}).parse(await boundedJson(response));
      job.icon=`yoto:#${data.displayIcon.mediaId}`;job.state="ready";await this.saveJob(id,job);return {state:job.state};
    });
  }
  async cancelUpload(id:string) {
    return this.serial(async()=>{
      await this.writeToken();await this.job(id);
      this.ctx.storage.kv.delete(`upload:${id}`);
      return {cancelled:true,note:"The connector can no longer use this job. A signed Yoto URL already issued cannot be revoked here; an in-flight transfer may finish. Already-prepared attachment previews are blocked."};
    });
  }
  async uploadStatus(id:string) {
    return this.serial(async()=>{
      const job=await this.job(id);const token=await this.writeToken();
      if(job.state==="processing"){
        if((job.polls??0)>=30)throw new Error("Polling limit reached");
        if(job.lastPoll&&Date.now()-job.lastPoll<5000)return {state:"processing",retryAfter:5};
        job.polls=(job.polls??0)+1;job.lastPoll=Date.now();await this.saveJob(id,job);
        const result=await this.api(`/media/upload/${encodeURIComponent(job.uploadId!)}/transcoded?loudnorm=false`) as {transcode?:Record<string,unknown>};
        const data=result.transcode;
        if(data?.transcodedSha256){
          const parsed=z.object({uploadId:z.string(),uploadSha256:z.string(),transcodedSha256:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),transcodedInfo:z.object({duration:z.number().nonnegative(),fileSize:z.number().int().positive().max(MAX_AUDIO),format:z.string().max(16),channels:z.union([z.string().max(16),z.number()]).optional()})}).parse(data);
          if(parsed.uploadId!==job.uploadId||parsed.uploadSha256!==job.sourceHash)throw new Error("Wrong transcoding result");
          job.media={trackUrl:`yoto:#${parsed.transcodedSha256}`,...parsed.transcodedInfo};job.state="ready";await this.saveJob(id,job);
        }
      }
      return {state:job.state,...(job.media?{duration:job.media.duration,readyToAttach:true}:{}),...(job.icon?{icon:job.icon}:{})};
    });
  }

  private async writeToken(): Promise<string> {
    if (this.env.WRITES_ENABLED !== "true") throw new Error("Writes disabled");
    const access = await this.accessToken();
    const tokens = await unseal<Tokens>(this.ctx.storage.kv.get<string>("tokens")!, this.env.TOKEN_ENCRYPTION_KEY);
    if (!tokens.scopes?.includes("user:content:manage")) throw new Error("Management permission required");
    return access;
  }

  private async api(path: string): Promise<unknown> {
    const token = await this.accessToken();
    const response = await fetch(`https://api.yotoplay.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000), redirect: "manual"
    });
    if (response.status === 401) {
      this.ctx.storage.kv.delete("tokens");
      throw new Error("Reconnect Yoto");
    }
    return boundedJson(response);
  }

  // Alarms are eventual cleanup; enforce retention before reporting or using credentials.
  private hasCredentials(): boolean {
    const expires = this.ctx.storage.kv.get<number>("expires") ?? 0;
    if (expires <= Date.now()) {
      this.ctx.storage.kv.delete("tokens");
      this.ctx.storage.kv.delete("refreshing");
      return false;
    }
    return !!this.ctx.storage.kv.get("tokens") && !this.ctx.storage.kv.get("refreshing");
  }

  private async accessToken(): Promise<string> {
    if (!this.hasCredentials()) throw new Error("Reconnect Yoto");
    const encrypted = this.ctx.storage.kv.get<string>("tokens");
    if (!encrypted || this.ctx.storage.kv.get("refreshing")) throw new Error("Reconnect Yoto");
    let tokens = await unseal<Tokens>(encrypted, this.env.TOKEN_ENCRYPTION_KEY);
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    // Persist BEFORE using the single-use refresh token. A crash or ambiguous
    // network failure requires reconnecting; never retry a consumed token.
    this.ctx.storage.kv.put("refreshing", true);
    await this.ctx.storage.sync();
    try {
      tokens = await exchangeTokens({ grant_type: "refresh_token", client_id: this.env.YOTO_CLIENT_ID, refresh_token: tokens.refreshToken });
      this.ctx.storage.kv.put("tokens", await seal(tokens, this.env.TOKEN_ENCRYPTION_KEY));
      this.ctx.storage.kv.delete("refreshing");
      return tokens.accessToken;
    } catch {
      this.ctx.storage.kv.delete("tokens");
      throw new Error("Reconnect Yoto");
    }
  }

  private async touch(): Promise<void> {
    const expires = Date.now() + RETENTION_MS;
    this.ctx.storage.kv.put("expires", expires);
    const alarm=await this.ctx.storage.getAlarm();
    if(alarm===null||alarm>expires)await this.ctx.storage.setAlarm(expires);
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const expires = this.ctx.storage.kv.get<number>("expires") ?? 0;
      let next=expires;
      for(const [key,entry] of await this.ctx.storage.list<{expires:number}>({prefix:"attachment:"})) {
        if(entry.expires<=Date.now())await this.ctx.storage.delete(key);else next=Math.min(next,entry.expires);
      }
      for(const [key,value] of await this.ctx.storage.list<string>({prefix:"upload:"})) {
        const job=await unseal<UploadJob>(value,this.env.TOKEN_ENCRYPTION_KEY);
        if(job.expires<=Date.now())await this.ctx.storage.delete(key);else next=Math.min(next,job.expires);
      }
      if (expires > Date.now()) { await this.ctx.storage.setAlarm(next); return; }
      await this.ctx.storage.deleteAll();
    });
  }
}
