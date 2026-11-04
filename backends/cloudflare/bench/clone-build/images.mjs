// Two-phase, snapshot-preserving registry teardown. No global garbage collection.
import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {account,prefix,registryTarget} from './scope.mjs';
import {registryPlan} from './registry-plan.mjs';
const mode=process.argv[2]??'list';if(!['list','delete'].includes(mode))throw new Error('list|delete');
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw new Error('Missing CF credential');
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({expiration_minutes:5,permissions:mode==='delete'?['pull','push']:['pull']})});
const auth=await response.json();if(!response.ok||auth.success===false)throw new Error(`Registry credentials HTTP ${response.status}`);
const password=(auth.result??auth).password;if(typeof password!=='string')throw new Error('Missing registry credential');
const headers={authorization:'Basic '+Buffer.from(`v1:${password}`).toString('base64'),accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'};
const request=(url,method='GET')=>fetch(url,{method,headers,signal:AbortSignal.timeout(60_000)});
const digestPattern=/^sha256:[a-f0-9]{64}$/;
async function inventory(){
 const repositories={},visited=new Set();let next='https://registry.cloudflare.com/v2/_catalog?tags=true';
 while(next){
  if(visited.has(next)||visited.size>=100)throw new Error('Incomplete registry pagination');visited.add(next);
  const url=new URL(next);if(url.origin!=='https://registry.cloudflare.com'||url.pathname!=='/v2/_catalog')throw new Error('Unexpected registry pagination target');url.searchParams.set('tags','true');
  const catalog=await request(url);if(!catalog.ok)throw new Error(`Registry catalog HTTP ${catalog.status}`);
  const body=await catalog.json();for(const [raw,tags]of Object.entries(body.repositories??{})){
   const repo=raw.replace(/^\/+/, '');if(!repo.startsWith(`${account}/${prefix}`))continue;
   if(!Array.isArray(tags))throw new Error('Registry tags shape');for(const tag of tags)registryTarget(repo,tag);
   repositories[repo]=[...new Set([...(repositories[repo]??[]),...tags])];
  }
  const link=catalog.headers.get('link');const links=[...(link??'').matchAll(/<([^>]+)>[^,]*?\brel=(?:"([^"]+)"|'([^']+)'|([^,;\s]+))/g)];
  if(link&&!links.length){const bare=/^([^;]+);\s*rel=(?:"([^"]+)"|'([^']+)'|([^,;\s]+))/.exec(link);if(bare)links.push(bare);else throw new Error('Malformed registry pagination header');}
  const match=links.find(m=>(m[2]??m[3]??m[4]).split(/\s+/).includes('next'));next=match?new URL(match[1],url).href:null;
 }
 const refs=[],nodes=[],missing=[],byDigest=new Map();
 async function load(repo,ref){
  const key=`${repo}@${ref}`;if(byDigest.has(key))return byDigest.get(key);
  const r=await request(registryTarget(repo,ref));
  if(r.status===404){
   // Catalog entries and orphan subjects can outlive their manifest. Keep the
   // missing edge: registryPlan still rejects it if a snapshot reaches it.
   if(/^rootfs-(?:set|snapshot)-/.test(ref))throw new Error(`Snapshot root missing: ${key}`);
   missing.push({repo,ref,status:404});byDigest.set(key,null);return null;
  }
  if(!r.ok)throw new Error(`Registry manifest HTTP ${r.status}: ${key}`);
  const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>2*1024*1024)throw new Error('Manifest too large');
  const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');if(r.headers.get('docker-content-digest')!==digest)throw new Error('Manifest digest mismatch');
  if(byDigest.get(`${repo}@${digest}`))return byDigest.get(`${repo}@${digest}`);
  const body=JSON.parse(bytes.toString('utf8'));
  const descriptors=[...(body.manifests??[]),...(body.subject?[body.subject]:[]),...(body.layers??[]).filter(d=>/manifest|index/.test(d.mediaType??''))];
  if(descriptors.some(d=>!digestPattern.test(d.digest)))throw new Error('Invalid child manifest digest');
  const node={repo,digest,mediaType:body.mediaType??r.headers.get('content-type'),artifactType:body.artifactType,size:bytes.length,dependencies:[...new Set(descriptors.map(d=>d.digest))]};
  byDigest.set(`${repo}@${digest}`,node);nodes.push(node);
  for(const child of node.dependencies)await load(repo,child);
  return node;
 }
 for(const [repo,tags]of Object.entries(repositories))for(const ref of tags){
  const node=await load(repo,ref);
  if(node)refs.push({repo,ref,digest:node.digest});
  else if(digestPattern.test(ref))refs.push({repo,ref,digest:ref,missing:true});
 }
 return {at:new Date().toISOString(),pages:visited.size,refs,nodes,missing};
}
const stamp=Date.now();await mkdir(new URL('./.state/',import.meta.url),{recursive:true});
const save=async(name,value)=>{const serialized=JSON.stringify(value,null,2)+'\n';if(serialized.includes(token)||serialized.includes(password))throw new Error('Refusing credential output');await writeFile(new URL(`./.state/${name}-${stamp}.json`,import.meta.url),serialized);};
const before=await inventory(),plan=registryPlan(before);await save('images-plan',{mode,before,plan});
const deleted=[],blocked=[];
if(mode==='delete'){
 // Complete the graph before the first deletion. Preserve even deploy aliases
 // of snapshot dependencies because deleting an alias may delete its manifest.
 for(const item of [...plan.remove].sort((a,b)=>Number(digestPattern.test(a.ref))-Number(digestPattern.test(b.ref)))){
  const head=await request(registryTarget(item.repo,item.ref),'HEAD');
  if(head.status===404){deleted.push({...item,deleteStatus:404,alreadyAbsent:true});continue;}
  if(!head.ok||head.headers.get('docker-content-digest')!==item.digest)throw new Error('Delete target changed since planning');
  const removed=await request(registryTarget(item.repo,item.ref),'DELETE');
  if(!removed.ok&&removed.status!==404){
   const message=(await removed.text()).slice(0,2000).replaceAll(token,'[redacted]').replaceAll(password,'[redacted]');
   if(removed.status===409){
    blocked.push({...item,deleteStatus:409,errorBody:message});await save('images-progress',{mode,plan,deleted,blocked});continue;
   }
   throw new Error(`Scoped manifest delete HTTP ${removed.status}: ${message}`);
  }
  deleted.push({...item,deleteStatus:removed.status});await save('images-progress',{mode,plan,deleted,blocked});
 }
}
const protectedChecks=[];
for(const item of [...plan.retained,...plan.protectedManifests.map(n=>({repo:n.repo,ref:n.digest,digest:n.digest}))]){
 const r=await request(registryTarget(item.repo,item.ref),'HEAD');protectedChecks.push({repo:item.repo,ref:item.ref,digest:item.digest,status:r.status,verified:r.ok&&r.headers.get('docker-content-digest')===item.digest});
}
const after=mode==='delete'?await inventory():before,remaining=registryPlan(after);
const live=remaining.remove.filter(x=>!x.missing),nodesByKey=new Map(after.nodes.map(x=>[`${x.repo}@${x.digest}`,x]));
const generatedArtifacts=[...new Set(live.map(x=>`${x.repo}@${x.digest}`))].map(key=>nodesByKey.get(key)).filter(x=>x?.artifactType?.startsWith('application/vnd.cloudchamber.'));
const generatedKeys=new Set(generatedArtifacts.map(x=>`${x.repo}@${x.digest}`));
const ordinaryImages=new Set(live.filter(x=>!generatedKeys.has(`${x.repo}@${x.digest}`)).map(x=>`${x.repo}@${x.digest}`));
const result={at:new Date().toISOString(),mode,pages:after.pages,images:remaining.remove,ordinaryImageCount:ordinaryImages.size,ordinaryTagCount:live.filter(x=>!digestPattern.test(x.ref)).length,generatedArtifactCount:generatedArtifacts.length,generatedArtifacts,missingManifests:after.missing,retainedSnapshotImages:remaining.retained.filter(x=>x.reason==='snapshot-root'),retainedSnapshotDependencies:remaining.retained.filter(x=>x.reason==='snapshot-dependency'),protectedManifests:remaining.protectedManifests,protectedChecks,deleted,blocked};
await save(`images-${mode}`,result);console.log(JSON.stringify(result,null,2));
if(protectedChecks.some(check=>!check.verified))throw new Error('Snapshot dependency verification failed');
if(mode==='delete'&&remaining.remove.some(x=>!x.missing))throw new Error('Unprotected registry refs remain');
