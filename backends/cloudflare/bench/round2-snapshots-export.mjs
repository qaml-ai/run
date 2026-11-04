import {readFile,writeFile} from 'node:fs/promises';
const manifests=JSON.parse(await readFile(new URL('.state/native-snapshot-manifests.json',import.meta.url),'utf8'));
const documents=[];
for(const path of ['../docs/round2-containers.json','.state/native-large-captured.json','.state/native-integrity.json','.state/native-image-delete-restore.json']){
 try{documents.push(JSON.parse(await readFile(new URL(path,import.meta.url),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
}
const timestamps=new Map();
for(const document of documents)for(const row of document.records??[]){if(!row.result.snapshot)continue;const id=row.result.snapshot.id;const prior=timestamps.get(id)??{};const r=row.result;
 timestamps.set(id,{capturedAt:r.capturedAt??prior.capturedAt,lastRestoredAt:r.lastRestoredAt&&(!prior.lastRestoredAt||r.lastRestoredAt>prior.lastRestoredAt)?r.lastRestoredAt:prior.lastRestoredAt});}
const snapshots=new Map();
for(const row of manifests.rows){const id=row.manifest.annotations?.['io.cloudflare.cloudchamber.snapshot_id'];if(!id)continue;const prior=snapshots.get(id);
 if(prior){prior.tags.push(row.tag);continue;}
 const dates=timestamps.get(id);if(!dates?.capturedAt||!dates.lastRestoredAt)throw new Error('Missing observed dates');
 snapshots.set(id,{id,name:id.startsWith('abc216')?'camelrun-proto-r2-small':'camelrun-proto-r2-large',repository:row.name,tags:[row.tag],sizeBytes:row.config.blob_size_bytes,manifestDigest:row.digest,baseArtifactDigest:row.config.base_artifact_digest,imageDigest:row.config.image_digest,...dates,estimatedExpiresAt:new Date(Date.parse(dates.lastRestoredAt)+30*86400000).toISOString()});
}
const baseArtifacts=manifests.rows.filter(x=>x.referencedBase).map(x=>({digest:x.digest,layerBytes:x.manifest.layers.reduce((s,l)=>s+l.size,0),layers:x.manifest.layers.map(l=>({digest:l.digest,sizeBytes:l.size}))}));
const report={title:'Retained snapshot backing artifacts',at:new Date().toISOString(),snapshots:[...snapshots.values()],uniqueSnapshotBytes:[...snapshots.values()].reduce((a,b)=>a+b.sizeBytes,0),baseArtifacts,notes:['Each snapshot has two registry aliases for the same manifest and layer. Sizes are counted once.','The snapshots also reference a shared converted base image. Base layer bytes are listed separately and exclude JSON metadata and the original Docker layers.','Expiry is the documented 30-day retention after the last successful restore; actual expiry was not observed.','Registry aliases and referenced base artifacts are retained as native snapshot backing data. Their later garbage collection timing is not exposed by the Worker API.']};
const text=JSON.stringify(report,null,2);const token=(await readFile(new URL('.state/api-token',import.meta.url),'utf8')).trim();
if([token,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(x=>text.includes(x)))throw new Error('Secret in report');
await writeFile(new URL('../docs/round2-snapshots.json',import.meta.url),text+'\n');console.log(text);
