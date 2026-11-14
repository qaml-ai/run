import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';
import { pngBytes } from '../../../tests/file-fixtures.ts';

test('standalone media uses source providers, repos and durable usage; rejects bad edits before fetching', {timeout:90000}, async t=>{
 const calls:any[]=[];
 const fake=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
  const bytes=Buffer.concat(chunks);
  calls.push({path:req.url,body:bytes});
  if(req.url==='/audio/speech'){res.writeHead(200,{'Content-Type':'audio/pcm'});res.write(Buffer.alloc(9999));res.end(Buffer.alloc(14001));return;}
  if(req.url==='/audio/transcriptions'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({text:'hello',languages:[{code:'en'}],usage:{type:'duration',seconds:1}}));return;}
  if(req.url==='/images/edits'||req.url==='/images/generations'){
   res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:[{b64_json:pngBytes(1024,1024).toString('base64')}],usage:{input_tokens:10,output_tokens:1000,input_tokens_details:{text_tokens:10,image_tokens:0}}}));return;
  }
  res.writeHead(404).end();
 }).listen(0,'127.0.0.1');await once(fake,'listening');t.after(()=>new Promise<void>(r=>fake.close(()=>r())));
 const token='local-integration-only-token-with-at-least-32-characters', cappedToken='local-capped-media-token-with-at-least-32-characters';
 const f=await startFixture({entrypoint:fileURLToPath(new URL('./camelfs-worker.ts',import.meta.url)),tenants:[{id:'camelrun-proto-local',token},{id:'capped-media',token:cappedToken}],vars:{AGENT_TENANTS_JSON:JSON.stringify({tenants:{'capped-media':{tokenSha256:createHash('sha256').update(cappedToken).digest('hex'),maxMonthlyCost:0}}}),PLATFORM_OPENAI_KEY:'fake-only-key',MEDIA_BASE_URL:`http://127.0.0.1:${(fake.address() as any).port}`}});t.after(()=>f.stop());
 const call=async(path:string,value:any)=>{const response=await fetch(f.url+path,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
 const image=await call('/v1/images',{prompt:'synthetic image'});assert.equal(image.images[0].width,1024);assert.equal(image.model,'openai/gpt-image-2.5-flare');
 await call('/v1/images',{prompt:'synthetic edit',images:[{data:pngBytes(10,10).toString('base64')}]});assert.equal(calls[1].path,'/images/edits');
 const created=await fetch(f.url+'/v1/repos',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify({name:'Images'})});
 assert.equal(created.status,201);const repo=await created.json() as any;
 const saved=await call('/v1/images',{prompt:'saved image',repo:repo.id,path:'art'});
 assert.equal(saved.images[0].repo,repo.id);assert.match(saved.images[0].version,/^[a-f0-9]{40}$/);assert.match(saved.images[0].path,/^art\/image-/);
 const content=await fetch(f.url+`/v1/repos/${repo.id}/files/${saved.images[0].path}`,{headers:{Authorization:`Bearer ${f.token}`}});
 assert.equal(content.status,200);assert.deepEqual(Buffer.from(await content.arrayBuffer()),pngBytes(1024,1024));
 const legacy=await fetch(f.url+'/v1/images',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify({prompt:'old',volumeId:'vol_old'})});
 assert.equal(legacy.status,400);assert.match((await legacy.json() as any).error,/Volumes are replaced by repos/);
 const before=calls.length;const invalid=await fetch(f.url+'/v1/images',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify({prompt:'x',mask:{data:pngBytes(10,10).toString('base64')}})});assert.equal(invalid.status,400);assert.equal(calls.length,before);
 for (const [path,value] of [['/v1/speech',{}],['/v1/speech',{text:12}],['/v1/transcriptions',{data:'',prompt:12}],['/v1/images',{prompt:'x',volumeId:12}],['/v1/images',{prompt:'x',images:[{data:'',extra:true}]}],['/v1/images',{prompt:'x',context:{tooLarge:'x'.repeat(4096)}}]] as const) {
  const rejected=await fetch(f.url+path,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(rejected.status,400,await rejected.text());
 }
 assert.equal(calls.length,before,'invalid shapes never reach providers');
 const wav=Buffer.alloc(44+48000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(48000,40);
 const transcript=await call('/v1/transcriptions',{data:wav.toString('base64'),language:'en'});assert.equal(transcript.text,'hello');assert.equal(transcript.durationSeconds,1);
 const speech=await fetch(f.url+'/v1/speech',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'Content-Type':'application/json'},body:JSON.stringify({text:'synthetic speech',format:'wav'})});assert.equal(speech.status,200);assert.equal((await speech.arrayBuffer()).byteLength,24044);
 const usage=await f.db.query('select model,responses from usage order by model');assert.deepEqual(usage.rows.map(r=>r.model),['image:openai/gpt-image-2.5-flare','speech:openai/gpt-4o-mini-tts','transcription:openai/gpt-transcribe']);
 // src/accounts.ts reads monthly caps from the operator's tenant configuration.
 const capped=await fetch(f.url+'/v1/images',{method:'POST',headers:{Authorization:`Bearer ${cappedToken}`,'Content-Type':'application/json'},body:JSON.stringify({prompt:'over cap'})});assert.equal(capped.status,402);assert.equal((await capped.json() as any).code,'SPEND_LIMIT');
});
