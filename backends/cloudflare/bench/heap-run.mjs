import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const base='https://camelrun-proto-r2-heap.miguel-85b.workers.dev';
const stamp=`h${Date.now()}`;const results=[];
async function call(id,op,input={}) {
 const start=performance.now();try {
  const r=await fetch(`${base}/agent/${id}/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});
  let data;try{data=await r.json();}catch{}
  return {status:r.status,data,ms:performance.now()-start};
 }catch(e){return {error:e.message,ms:performance.now()-start};}
}
async function save(){const s=JSON.stringify({at:new Date().toISOString(),stamp,results},null,2);if(s.includes(token))throw Error('secret');await writeFile(new URL('./.state/round2-heap.json',import.meta.url),s);}
for(const n of [0,1000,10000,50000]) {
 const id=`${stamp}-${n}`;const row={id,n,bytesPerMessage:1024,started:new Date().toISOString(),prepare:await call(id,'prepare'),seeds:[]};results.push(row);await save();
 if(row.prepare.status!==200){console.log(JSON.stringify(row));break;}
 for(let i=0;i<n;i+=1000){const s=await call(id,'seed',{count:Math.min(1000,n-i),bytes:1024});row.seeds.push(s);if(s.status!==200)break;await save();}
 row.load=await call(id,'load');await save();console.log(JSON.stringify({id,n,load:row.load,seedsOk:row.seeds.filter(x=>x.status===200).length}));
 row.allocations=[];
 if(row.load.status===200){
  const instance=row.load.data.instance;
  for(let i=0;i<36;i++){
   const a=await call(id,'allocate',{mib:4});row.allocations.push(a);await save();
   if(a.status!==200||a.data.instance!==instance)break;
  }
  row.after=await call(id,'status');await save();
  console.log(JSON.stringify({id,n,allocations:row.allocations.map(a=>({status:a.status,miB:a.data?.allocationMiB,error:a.data?.error??a.error,instance:a.data?.instance})),after:row.after}));
 }
 row.clear=await call(id,'clear');row.ended=new Date().toISOString();await save();
}
