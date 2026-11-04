// Read-only scoped manifest/dependency inventory. Credentials stay in memory.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {account,prefix} from '../scope.mjs';
const token=process.env.CLOUDFLARE_API_TOKEN;if(!token)throw new Error('Missing CF credential');
const authResponse=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({expiration_minutes:5,permissions:['pull']})});
const auth=await authResponse.json();if(!authResponse.ok||auth.success===false)throw new Error(`Registry credentials HTTP ${authResponse.status}`);
const password=(auth.result??auth).password;if(typeof password!=='string')throw new Error('Missing registry credential');
const headers={authorization:'Basic '+Buffer.from(`v1:${password}`).toString('base64'),accept:'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'};
const digest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
const repoOk=repo=>new RegExp(`^${account}/${prefix}[a-z0-9][a-z0-9._-]*$`).test(repo);
const target=(repo,ref,kind='manifests')=>{if(!repoOk(repo)||!(digest(ref)||/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(ref)))throw new Error('Outside scoped registry target');return `https://registry.cloudflare.com/v2/${repo}/${kind}/${ref}`;};
const repositories={};let next='https://registry.cloudflare.com/v2/_catalog?tags=true';const visited=new Set();
while(next){
 const url=new URL(next);if(url.origin!=='https://registry.cloudflare.com'||url.pathname!=='/v2/_catalog'||visited.has(next)||visited.size>=100)throw new Error('Invalid catalog pagination');visited.add(next);url.searchParams.set('tags','true');
 const r=await fetch(url,{headers});if(!r.ok)throw new Error(`Catalog HTTP ${r.status}`);const body=await r.json();
 for(const [raw,tags]of Object.entries(body.repositories??{})){const repo=raw.replace(/^\/+/, '');if(!repo.startsWith(`${account}/${prefix}`))continue;if(!repoOk(repo)||!Array.isArray(tags))throw new Error('Unexpected scoped repository');repositories[repo]=[...new Set([...(repositories[repo]??[]),...tags])];}
 const link=r.headers.get('link');const m=link?.match(/<?([^<>;,\s]+)>?;\s*rel="?next"?/);if(link&&!m)throw new Error('Unexpected catalog Link');next=m?new URL(m[1],url).href:null;
}
const nodes=[],refs=[],byDigest=new Map(),queue=[];
for(const [repo,tags]of Object.entries(repositories))for(const ref of tags)queue.push({repo,ref,catalog:true});
function digestFields(value,path=''){
 const fields=[];if(digest(value))fields.push({path,digest:value});else if(Array.isArray(value))value.forEach((v,i)=>fields.push(...digestFields(v,`${path}[${i}]`)));else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value))fields.push(...digestFields(v,path?`${path}.${k}`:k));return fields;
}
while(queue.length){
 const {repo,ref,catalog}=queue.shift();const key=`${repo}@${ref}`;if(byDigest.has(key)){if(catalog)refs.push({repo,ref,digest:ref});continue;}
 const r=await fetch(target(repo,ref),{headers});const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>2*1024*1024)throw new Error('Manifest exceeds inspection limit');
 if(!r.ok){refs.push({repo,ref,status:r.status});continue;}
 const value=JSON.parse(bytes.toString('utf8')),computed='sha256:'+createHash('sha256').update(bytes).digest('hex'),manifestDigest=r.headers.get('docker-content-digest')??computed;
 if(computed!==manifestDigest)throw new Error('Manifest digest mismatch');
 if(catalog)refs.push({repo,ref,digest:manifestDigest,status:r.status});
 if(byDigest.has(`${repo}@${manifestDigest}`))continue;
 const descriptors=[...(value.manifests??[]),...(value.layers??[]),...(value.blobs??[]),...(value.config?[value.config]:[]),...(value.subject?[value.subject]:[])].map(d=>({mediaType:d.mediaType,digest:d.digest,size:d.size,annotations:d.annotations}));
 const node={repo,digest:manifestDigest,size:bytes.length,mediaType:value.mediaType??r.headers.get('content-type'),schemaVersion:value.schemaVersion,artifactType:value.artifactType,keys:Object.keys(value),descriptors,digestFields:digestFields(value),annotations:value.annotations};
 byDigest.set(`${repo}@${manifestDigest}`,node);nodes.push(node);
 for(const d of descriptors)if(digest(d.digest)&&/(manifest|index)/.test(d.mediaType??''))queue.push({repo,ref:d.digest,catalog:false});
 if(digest(value.config?.digest)&&/json/.test(value.config?.mediaType??'')){
  const cr=await fetch(target(repo,value.config.digest,'blobs'),{headers});if(cr.ok){const content=await cr.text();if(content.length<=1024*1024){const cv=JSON.parse(content);node.configSummary={digest:value.config.digest,keys:Object.keys(cv),digestFields:digestFields(cv),rootfsType:cv.rootfs?.type,envNames:cv.config?.Env?.map(v=>v.split('=')[0])};}}else node.configStatus=cr.status;
 }
}
const result={at:new Date().toISOString(),catalogPages:visited.size,repositories,refs,nodes};const serialized=JSON.stringify(result,null,2)+'\n';if(serialized.includes(token)||serialized.includes(password))throw new Error('Refusing credential output');
await mkdir(new URL('./.state/',import.meta.url),{recursive:true});await writeFile(new URL('./.state/registry-dependencies.json',import.meta.url),serialized);
console.log(JSON.stringify({catalogPages:visited.size,refs,nodes:nodes.map(({repo,digest,mediaType,artifactType,size,descriptors,annotations,configSummary})=>({repo:repo.slice(account.length+1),digest,mediaType,artifactType,size,descriptors,annotations,configSummary}))},null,2));
