import {readFile,writeFile} from 'node:fs/promises';
const account='85bbd288051330fb51ee1c86031a299b';
const name='camelrun-proto-r2-computers-camelrun-proto-r2-native-workspace';
const inventory=JSON.parse(await readFile(new URL('.state/round2-images-list.json',import.meta.url),'utf8'));
const tags=inventory.items.find(x=>x.name===name)?.tags??[];
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,{method:'POST',headers:{authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({expiration_minutes:5,permissions:['pull']})});
const data=await response.json();if(!response.ok||!data.success)throw new Error('Registry read credential failed');
const password=data.result.password;const headers={authorization:'Basic '+Buffer.from('v1:'+password).toString('base64'),accept:'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json'};
const rows=[];
for(const tag of tags){
 if(!/^(rootfs-(snapshot|set)-[a-f0-9]+|wrangler-[a-z0-9]+)$/.test(tag))throw new Error('Unexpected tag');
 const r=await fetch(`https://registry.cloudflare.com/v2/${account}/${name}/manifests/${tag}`,{headers});if(!r.ok)throw new Error('Manifest read failed '+r.status);
 const manifest=await r.json();let config;
 if(manifest.config?.digest){const c=await fetch(`https://registry.cloudflare.com/v2/${account}/${name}/blobs/${manifest.config.digest}`,{headers});if(c.ok){const content=await c.text();try{const d=JSON.parse(content);config={keys:Object.keys(d),created:d.created,architecture:d.architecture,os:d.os,rootfs:d.rootfs,annotations:d.annotations,...Object.fromEntries(['snapshot_id','snapshot_set_id','image_ref','image_digest','blob_size_bytes','base_artifact_digest','base_final_chain_id','created_at_unix_seconds','snapshot_format','restore_chain'].filter(k=>d[k]!==undefined).map(k=>[k,d[k]]))};}catch{config={bytes:content.length,nonJson:true};}}}
 rows.push({name,tag,digest:r.headers.get('Docker-Content-Digest'),manifest,config});
}
for(const digest of new Set(rows.map(x=>x.manifest.subject?.digest).filter(Boolean))){
 if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('Unexpected subject digest');
 const r=await fetch(`https://registry.cloudflare.com/v2/${account}/${name}/manifests/${digest}`,{headers});if(!r.ok)throw new Error('Base artifact read failed '+r.status);
 rows.push({name,tag:null,digest:r.headers.get('Docker-Content-Digest'),manifest:await r.json(),referencedBase:true});
}
const serialized=JSON.stringify({at:new Date().toISOString(),rows},null,2);
const bearer=(await readFile(new URL('.state/api-token',import.meta.url),'utf8')).trim();
if([password,bearer,process.env.CLOUDFLARE_API_TOKEN].filter(Boolean).some(x=>serialized.includes(x)))throw new Error('Credential in output');
await writeFile(new URL('.state/native-snapshot-manifests.json',import.meta.url),serialized+'\n');console.log(serialized);
