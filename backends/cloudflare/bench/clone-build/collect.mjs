// Generate reviewable evidence from completed runner JSON, without credentials.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lifecycleVerification} from './runner.mjs';

const stepNames=['express-clone','express-install','express-test','rust-install','ripgrep-clone','ripgrep-build'];
const stemPattern=`(?:${stepNames.join('|')})(?:-[a-zA-Z0-9_]+)*`;
const numberPattern='(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const unique=values=>[...new Set(values)];

// A poll shell's exit status describes cat/tail/test, not the background build.
// Only an explicit recorded status, or a foreground wrapper preserving $?, is
// evidence of the measured command's exit status. Keep ambiguous values null.
export function parseStepCall(call){
 if(call.source!=='agent'||call.request?.op!=='exec')return [];
 const cmd=call.request.argv?.join(' ')??'';
 const stems=unique([
  ...cmd.matchAll(new RegExp(`\\bSTEP=["']?(${stemPattern})(?=["';\\s]|$)`,'g')),
  ...cmd.matchAll(new RegExp(`\\/(${stemPattern})\\.(?:time|log|rc)\\b`,'g')),
 ].map(match=>match[1]));
 // Recaps print several previous timing files. They are preserved in raw trace,
 // but are not additional executions or polls of one measured command.
 if(stems.length!==1)return [];
 const artifact=stems[0],step=stepNames.find(name=>artifact===name||artifact.startsWith(name+'-'));
 const stdout=call.result?.stdout??'',stderr=call.result?.stderr??'';
 const wallSamples=[...stdout.matchAll(new RegExp(`^BENCH_WALL_SECONDS=(${numberPattern})[\\t ]*\\r?$`,'gm'))].map(match=>Number(match[1]));
 const statusSamples=[...stdout.matchAll(/^(?:DONE[\t ]+rc[\t ]*=[\t ]*|RC(?:[\t ]+FOUND)?[\t ]*[:=][\t ]*)(?:\r?\n[\t ]*)?(-?\d+)[\t ]*$/gmi)].map(match=>({value:Number(match[1]),source:'explicit-rc'}));
 const timeStatuses=[...stdout.matchAll(/^Command exited with non-zero status (\d+)[\t ]*$/gm)].map(match=>({value:Number(match[1]),source:'gnu-time-status'}));
 const signals=[...stdout.matchAll(/^Command terminated by signal (\d+)[\t ]*$/gm)].map(match=>Number(match[1]));
 const statuses=[...statusSamples,...timeStatuses],exitValues=unique(statuses.map(status=>status.value));
 const launchesBackgroundJob=/\b(?:nohup|setsid)\b/.test(cmd);
 const preservedVariable=/(?:^|;)\s*([a-zA-Z_]\w*)=\$\?\s*;/.exec(cmd)?.[1];
 const foregroundPreservesExit=Boolean(/\/usr\/bin\/time\s/.test(cmd)&&!launchesBackgroundJob&&preservedVariable&&new RegExp(`\\bexit\\s+["']?\\$${preservedVariable}["']?\\s*$`).test(cmd));
 const toolExitCode=Number.isInteger(call.result?.exitCode)?call.result.exitCode:null;
 let exitCode=null,exitCodeSource=null;
 if(exitValues.length===1){exitCode=exitValues[0];exitCodeSource=statusSamples.length?'explicit-rc':'gnu-time-status';}
 else if(exitValues.length===0&&foregroundPreservesExit&&toolExitCode!==null){exitCode=toolExitCode;exitCodeSource='foreground-preserved-exit';}
 const observationKind=foregroundPreservesExit?'foreground-command':launchesBackgroundJob?(wallSamples.length?'previous-timing-and-background-launch':'background-launch'):'recorded-output';
 return [{step,artifact,seq:call.seq??null,observationKind,wallSeconds:wallSamples.length===1?wallSamples[0]:null,wallSamples,toolWallSeconds:Number.isFinite(call.wallMs)?call.wallMs/1000:null,exitCode,exitCodeSource,statusSamples:statuses,terminationSignals:signals,pollShellExitCode:toolExitCode,ambiguousExitStatus:exitValues.length>1,error:call.error??null,stdout,stderr}];
}

export function collectRun(raw){
 const calls=raw.trace?.calls??[],start=calls.find(c=>c.source==='agent'&&c.request.op==='start'),exec=calls.find(c=>c.source==='agent'&&c.request.op==='exec'&&c.result);
 const steps={};
 for(const call of calls){
  for(const {step,...observation} of parseStepCall(call))(steps[step]??=[]).push(observation);
 }
 const messages=raw.history?.messages??[],usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalCost:0};
 for(const m of messages)if(m.role==='assistant'&&m.usage){for(const k of ['input','output','cacheRead','cacheWrite'])usage[k]+=m.usage[k]??0;usage.totalCost+=m.usage.cost?.total??0;}
 const lifecycle=raw.lifecycle?{...raw.lifecycle,verification:lifecycleVerification(raw.lifecycle,raw.lifecycle.snapshot?.value?.snapshot)}:undefined;
 return {label:raw.label,startSeconds:start?.wallMs/1000,readinessSeconds:start?.result?.elapsedMs/1000,decisionToDiagnosticSeconds:start&&exec?(exec.startedMs+exec.wallMs-start.startedMs)/1000:null,diagnostics:exec?.result?.stdout,steps,modelCalls:raw.trace?.modelCalls,usage,status:raw.guidedRecovery?.record?.status??raw.record?.status,initialStatus:raw.record?.status,lifecycle,raw};
}

async function main(){
 const files=[],args=process.argv.slice(2);let output=new URL('../../docs/clone-build-evidence-2026-11-04.json',import.meta.url);
 for(let i=0;i<args.length;i++){if(args[i]==='--out'){if(!args[i+1])throw new Error('--out requires a path');output=args[++i];}else files.push(args[i]);}
 if(!files.length)throw new Error('Pass runner result files');
 const rows=await Promise.all(files.map(async file=>collectRun(JSON.parse(await readFile(file,'utf8')))));
 const evidence={measuredAt:new Date().toISOString(),scope:'camelrun-proto-bench-*',rows};
 const secret=process.env.CLOUDFLARE_API_TOKEN,serialized=JSON.stringify(evidence,null,2)+'\n';if(secret&&serialized.includes(secret))throw new Error('Refusing to write credential');
 await writeFile(output,serialized);
 console.log(JSON.stringify(rows.map(({raw,lifecycle,diagnostics,...row})=>row),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
