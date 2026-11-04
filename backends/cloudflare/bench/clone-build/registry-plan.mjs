// The registry exposes digest references alongside tags. Snapshot manifests
// depend on a converted filesystem chain and the original image. Keep aliases
// of reachable manifests too: managed-registry tag unlink semantics are unknown.
export function registryPlan({refs,nodes}){
 const key=(repo,digest)=>`${repo}@${digest}`;
 const byDigest=new Map(nodes.map(node=>[key(node.repo,node.digest),node]));
 const rootKeys=new Set(refs.filter(ref=>/^rootfs-(?:set|snapshot)-[a-f0-9]+$/.test(ref.ref)).map(ref=>key(ref.repo,ref.digest)));
 for(const node of nodes)if(node.artifactType==='application/vnd.cloudchamber.rootfs-snapshot.v1')rootKeys.add(key(node.repo,node.digest));
 const protectedKeys=new Set(),pending=[...rootKeys];
 while(pending.length){
  const current=pending.pop();if(protectedKeys.has(current))continue;
  const node=byDigest.get(current);if(!node)throw new Error(`Snapshot dependency missing: ${current}`);
  protectedKeys.add(current);
  for(const child of node.dependencies??[])pending.push(key(node.repo,child));
 }
 const retained=[],remove=[];
 for(const ref of refs){
  const current=key(ref.repo,ref.digest);
  (protectedKeys.has(current)?retained:remove).push({...ref,reason:protectedKeys.has(current)?rootKeys.has(current)?'snapshot-root':'snapshot-dependency':'not-snapshot-reachable'});
 }
 const protectedManifests=[...protectedKeys].map(current=>({...byDigest.get(current),reason:rootKeys.has(current)?'snapshot-root':'snapshot-dependency'}));
 return {retained,remove,protectedManifests,rootCount:rootKeys.size};
}
