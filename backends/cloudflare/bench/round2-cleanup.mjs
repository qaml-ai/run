// Prefix-scoped application/image cleanup. Deliberately omits account-wide
// registry layer GC performed by `wrangler containers images delete`.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
const account='85bbd288051330fb51ee1c86031a299b',prefix='camelrun-proto-';
const action=process.argv[2];if(!['images-list','images-delete','apps-delete'].includes(action))throw new Error('Invalid cleanup action');
const repository=process.argv[3];
if(repository&&(!repository.startsWith(prefix)||!/^[a-z0-9-]+$/.test(repository)||action==='apps-delete'))throw new Error('Invalid repository scope');
const headers={authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
async function api(path,method='GET',body){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{method,headers,body:body?JSON.stringify(body):undefined});const text=await r.text();const d=text?JSON.parse(text):{};if(!r.ok||d.success===false)throw new Error(`Cloudflare ${method} HTTP ${r.status}`);return d.result??d;}
const result={at:new Date().toISOString(),action,items:[]};
if(action==='apps-delete'){
 const r=await api('/containers/applications');
 for(const app of (Array.isArray(r)?r:r.applications??[]).filter(x=>x.name.startsWith(prefix))){
  if(!/^[a-f0-9]{32}$/.test(app.id))throw new Error('Invalid app ID');
  await api(`/containers/applications/${app.id}`,'DELETE');result.items.push({id:app.id,name:app.name,deleted:true});
 }
}else{
 const {stdout}=await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','containers','images','list','--config','bench/round2-native.wrangler.jsonc','--filter','(^|/)camelrun-proto-','--json'],{env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:'bench/.state/logs'},maxBuffer:1024*1024});
 const images=JSON.parse(stdout).filter(image=>!repository||image.name===repository);
 for(const image of images)if(!image.name.startsWith(prefix)||image.name.includes('/'))throw new Error('Image outside scope');
 if(action==='images-list')result.items=images;
 else if(images.length){
  const credentials=await api('/containers/registries/registry.cloudflare.com/credentials','POST',{expiration_minutes:5,permissions:['pull','push']});
  const auth='Basic '+Buffer.from('v1:'+credentials.password).toString('base64');
  for(const image of images)for(const tag of image.tags){
   if(/^rootfs-(snapshot|set)-[a-f0-9]+$/.test(tag)){
    (result.retainedSnapshotArtifacts??=[]).push({name:image.name,tag});continue;
   }
   if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag))throw new Error('Invalid image tag');
   const url=`https://registry.cloudflare.com/v2/${account}/${image.name}/manifests/${tag}`;
   const h={authorization:auth,accept:'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'};
   const head=await fetch(url,{method:'HEAD',headers:h});if(!head.ok)throw new Error(`Image HEAD ${head.status}`);
   const digest=head.headers.get('Docker-Content-Digest');
   if(!digest||!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('Missing image manifest digest');
   const deletion=await fetch(url,{method:'DELETE',headers:h});if(!deletion.ok)throw new Error(`Image DELETE ${deletion.status}`);
   result.items.push({name:image.name,tag,digest,deleted:true});
  }
 }
}
const serialized=JSON.stringify(result,null,2);if(process.env.CLOUDFLARE_API_TOKEN&&serialized.includes(process.env.CLOUDFLARE_API_TOKEN))throw new Error('Credential guard');
await writeFile(`bench/.state/round2-${action}.json`,serialized+'\n');console.log(serialized);
