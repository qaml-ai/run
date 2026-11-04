import {readFile,writeFile} from 'node:fs/promises';
import {distribution} from './codemode-run.mjs';
const token=(await readFile(new URL('./.state/api-token',import.meta.url),'utf8')).trim();
const base='https://camelrun-proto-r2-codemode.miguel-85b.workers.dev';
const run=`r2-${Date.now()}`; const results=[];
const request=async(path,input)=>{
 const start=performance.now();
 try {const r=await fetch(base+path,{method:input?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(65000)});let data;try{data=await r.json();}catch{} return {status:r.status,httpMs:performance.now()-start,data};}
 catch(e){return {error:e.message,httpMs:performance.now()-start};}
};
const diagnosis=process.argv.includes('--causal');
const isolated=process.argv.includes('--isolated');
const barrier=process.argv.includes('--barrier');
const tests=barrier?[
 {name:'barrier-50-agents-50-scripts',agents:50,scripts:50,mode:'isolated',barrier:true},
 {name:'barrier-50-agents-200-scripts',agents:50,scripts:200,mode:'isolated',barrier:true},
]:isolated?[
 {name:'isolated-50-agents-50-scripts',agents:50,scripts:50,mode:'isolated'},
 {name:'isolated-50-agents-200-scripts',agents:50,scripts:200,mode:'isolated'},
 {name:'isolated-50-agents-200-scripts-repeat',agents:50,scripts:200,mode:'isolated'},
]:diagnosis?[
 {name:'50-shared-no-callback',agents:50,scripts:50,mode:'shared',count:0,timeoutMs:60000},
 {name:'50-shared-one-callback',agents:50,scripts:50,mode:'shared',count:1,timeoutMs:60000},
 {name:'50-shared-twenty-callback',agents:50,scripts:50,mode:'shared',count:20,timeoutMs:60000},
 {name:'50-samecaller-twentyone-callback',agents:1,scripts:50,mode:'agent',count:21,timeoutMs:15000},
]:process.argv.includes('--quick') ? [
 {name:'single',agents:1,scripts:1,mode:'agent'},
 ...[2,4,8,16,32,50].map(n=>({name:`shared-${n}`,agents:1,scripts:n,mode:'agent'})),
 {name:'fifty-caller-shared-sandbox',agents:50,scripts:50,mode:'shared'},
 {name:'one-caller-fifty-sandbox',agents:1,scripts:50,mode:'script'},
] : [
 {name:'50-agents-50-scripts-agent',agents:50,scripts:50,mode:'agent'},
 {name:'50-agents-200-scripts-agent',agents:50,scripts:200,mode:'agent'},
 {name:'50-agents-200-scripts-script',agents:50,scripts:200,mode:'script'},
];
for(const test of tests){
 const batch=`${run}-${test.name}`, start=performance.now(); let done=false;const probes=[];
 const execution=Promise.all(Array.from({length:test.scripts},(_,i)=>request(`/caller/${batch}-${i%test.agents}/run`,{count:20,timeoutMs:15000,...test,shared:batch,batch}))).finally(()=>done=true);
 const probe=async()=>{while(!done){probes.push(await request(`/caller/${batch}-0/status`));await new Promise(r=>setTimeout(r,1000));}};
 await Promise.all([execution,probe()]);const rows=await execution;
 const summary={...test,elapsedMs:performance.now()-start,ok:rows.filter(r=>r.data?.result?.ok&&r.data.result.value===(test.count??20)).length,
  httpMs:distribution(rows.map(r=>r.httpMs)),wallMs:distribution(rows.map(r=>r.data?.wallMs)),callbacks:distribution(rows.map(r=>r.data?.callbacks?.length)),
  errors:[...new Set(rows.filter(r=>!r.data?.result?.ok).map(r=>r.error??r.data?.error??JSON.stringify(r.data?.result?.error)))],probeMs:distribution(probes.map(r=>r.httpMs))};
 results.push({summary,rows,probes,...(test.mode==='shared'?{sandbox:await request(`/sandbox/${batch}`)}:{})});
 const out={at:new Date().toISOString(),run,results}; const s=JSON.stringify(out,null,2);if(s.includes(token))throw Error('secret');
 await writeFile(new URL(`./.state/round2-codemode-${barrier?'barrier':isolated?'isolated':diagnosis?'causal':process.argv.includes('--quick')?'diagnostic':'load'}.json`,import.meta.url),s);
 console.log(JSON.stringify(summary));
}
