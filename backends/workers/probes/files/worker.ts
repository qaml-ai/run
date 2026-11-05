import { Volume } from '../../src/volume.ts';
import { uploadFile } from '../../src/file-upload.ts';
import { digest } from '../../src/volume.ts';
import type { FileBindings } from '../../src/files.ts';
export { Volume };
interface Env { VOLUMES:DurableObjectNamespace<Volume>; BUCKET:R2Bucket; API_TOKEN:string }
const DAY=86400_000;
const json=(value:unknown,status=200)=>Response.json(value,{status});
export default {
  async fetch(request:Request,env:Env) {
    if(request.headers.get('authorization')!==`Bearer ${env.API_TOKEN}`)return json({error:'Unauthorized'},401);
    if(new URL(request.url).pathname==='/cleanup') {
      let cursor:string|undefined;let removed=0;
      do {const objects=await env.BUCKET.list({cursor});if(objects.objects.length)await env.BUCKET.delete(objects.objects.map(o=>o.key));removed+=objects.objects.length;cursor=objects.truncated?objects.cursor:undefined;}while(cursor);
      return json({removed,remaining:(await env.BUCKET.list()).objects.length});
    }
    if(new URL(request.url).pathname!=='/run')return json({ok:true});
    const startedAt=Date.now(),v=env.VOLUMES.getByName('probe:vol_probe');await v.initialize('probe','vol_probe','cloud probe');
    const first=await v.write('/a.txt',new TextEncoder().encode('first'),'text/plain');
    const snapshot=await v.snapshot('retained',{pinned:true,labels:{fixture:'cloud'}});
    const writes=await Promise.allSettled(['one','two'].map(text=>v.write('/a.txt',new TextEncoder().encode(text),'text/plain',first.version)));
    const cas={success:writes.filter(r=>r.status==='fulfilled').length,conflicts:writes.filter(r=>r.status==='rejected'&&String(r.reason).includes('FILE_412:')).length};
    const saved=await v.read('/a.txt',snapshot.id);
    await v.pin('agent:probe',[first.key]);await v.deleteSnapshot(snapshot.id,true);
    const mark=await v.collectGarbage(startedAt);
    const sweep=await v.collectGarbage(startedAt+DAY+1);
    const pinRetained=!!(await env.BUCKET.head(first.key));
    await v.unpin('agent:probe');await v.collectGarbage(startedAt+DAY+2);const unpinned=await v.collectGarbage(startedAt+2*DAY+3);
    const pinReleased=!(await env.BUCKET.head(first.key));
    const size=6*1024*1024+7;let remaining=size;
    const bytes=new ReadableStream<Uint8Array>({pull(controller){if(!remaining){controller.close();return;}const part=new Uint8Array(Math.min(65536,remaining));part.fill(42);remaining-=part.length;controller.enqueue(part);}});
    const uploadStart=Date.now();const uploaded=await uploadFile(env as unknown as FileBindings,'probe','vol_probe','/large.bin',bytes,'application/octet-stream');
    const large=await v.read('/large.bin');
    const result={startedAt,endedAt:Date.now(),cas,snapshot:{read:new TextDecoder().decode(saved.bytes),pinned:snapshot.pinned,labels:snapshot.labels},gc:{mark,sweep,unpinned,pinRetained,pinReleased},multipart:{size:uploaded.size,sha256:uploaded.sha256,verified:(await digest(large.bytes))===uploaded.sha256,lastByte:large.bytes.at(-1),elapsedMs:Date.now()-uploadStart}};
    return json(result);
  }
} satisfies ExportedHandler<Env>;
