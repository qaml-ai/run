const TABLES = new Set(['agent_triggers','trigger_deliveries','trigger_run_agents']);
export function triggerQuery(db: {query(text:string,values?:unknown[]):Promise<{rows:any[];rowCount:number|null}>}) {
 return async(text:string,values:unknown[]=[])=>{
  const names=[...text.matchAll(/\b(?:from|into|update|join|table)\s+([a-z_]+)/gi)].map(m=>m[1]!.toLowerCase());
  if(!names.length||names.some(name=>!TABLES.has(name)))throw new Error('Trigger fixture queries touch only trigger tables');
  const {rows,rowCount}=await db.query(text,values);return {rows,rowCount};
 };
}
