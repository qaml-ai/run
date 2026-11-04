const timestamp=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'?Date.parse(value):NaN;
const callStart=call=>timestamp(call.startedMs??call.startedAt);
const callEnd=call=>callStart(call)+(Number.isFinite(call.wallMs)?call.wallMs:0);

// Saved agentEndedAt can predate a guided recovery. A stop before a later start
// does not close the run, and an absent end timestamp is not zero running time.
export function runWindow(run){
 const calls=run.trace?.calls??[];
 const starts=calls.filter(call=>call.request?.op==='start'&&Number.isFinite(callStart(call)));
 const startMs=starts.length?Math.min(...starts.map(callStart)):NaN;
 const evidence=[
  ['endedAt',timestamp(run.endedAt)],
  ['agentEndedAt',timestamp(run.agentEndedAt)],
  ['record.endedAt',timestamp(run.record?.endedAt)],
  ['guidedRecovery.endedAt',timestamp(run.guidedRecovery?.endedAt)],
  ['guidedRecovery.record.endedAt',timestamp(run.guidedRecovery?.record?.endedAt)],
  ...calls.map(call=>[`trace:${call.seq??'unknown'}`,callEnd(call)]),
 ].filter(([,time])=>Number.isFinite(time));
 evidence.sort((a,b)=>b[1]-a[1]);
 const stopCalls=calls.filter(call=>call.request?.op==='stop'&&call.result?.stopped&&Number.isFinite(callEnd(call))).sort((a,b)=>callEnd(b)-callEnd(a));
 const lastStop=stopCalls[0];
 let stopMs=lastStop?callEnd(lastStop):NaN,stopBasis=lastStop?`trace:${lastStop.seq??'unknown'}`:null;
 // Some older lifecycle captures saved stop before refreshing the trace.
 if(run.lifecycle?.stop?.value?.stopped&&Number.isFinite(timestamp(run.endedAt))&&(!Number.isFinite(stopMs)||timestamp(run.endedAt)>stopMs)){
  stopMs=timestamp(run.endedAt);stopBasis='lifecycle.stop + endedAt';
 }
 const activeOperations=new Set(['start','exec','read','write','snapshot','restore']);
 const laterActivity=Number.isFinite(stopMs)&&calls.some(call=>activeOperations.has(call.request?.op)&&callStart(call)>=stopMs);
 const closedByObservedStop=Number.isFinite(stopMs)&&!laterActivity;
 const endMs=closedByObservedStop?stopMs:evidence[0]?.[1]??NaN;
 return {startMs,endMs,from:Number.isFinite(startMs)?new Date(startMs).toISOString():null,to:Number.isFinite(endMs)?new Date(endMs).toISOString():null,closedByObservedStop,endBasis:closedByObservedStop?stopBasis:evidence[0]?.[0]??null,stopFollowedByActivity:Boolean(laterActivity),pendingCallSequences:calls.filter(call=>!call.result&&!call.error).map(call=>call.seq??null)};
}
