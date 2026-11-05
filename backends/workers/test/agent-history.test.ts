import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHistory } from "../src/history.ts";

function fixture() {
  const database=new DatabaseSync(":memory:");
  const sql={exec(query:string,...args:any[]) {
    const statement=database.prepare(query);
    const rows=statement.all(...args);
    return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};
  }};
  const entries:any[]=[];
  const reads:{from:number,size:number}[]=[];
  const root={async entries(query:any,size:number,cursor?:number) {
    reads.push({from:query.minEntryId,size});
    const candidates=entries.filter(entry=>entry.id>=query.minEntryId);
    const start=cursor??0;
    return {items:candidates.slice(start,start+size),...(start+size<candidates.length?{next:start+size}:{})};
  }};
  const atomic=<T>(write:()=>T):T=>{database.exec("BEGIN");try{const value=write();database.exec("COMMIT");return value;}catch(error){database.exec("ROLLBACK");throw error;}};
  return {database,history:new AgentHistory(sql as never,atomic),entries,reads,root:root as never};
}
const url=(query="")=>new URL(`https://agent/history${query}`);

test("history indexes more than 1000 messages incrementally and pages whole turns in both directions", async t=>{
  const f=fixture();t.after(()=>f.database.close());
  f.entries.push({id:1,model:[{role:"system",content:"private system"}]});
  for(let n=0;n<1300;n++) f.entries.push({id:n+2,kind:n%2===0?"camel.prompt":"pi.assistant",data:n%2===0?{requestId:`r${n}`,metadata:{n}}:undefined,model:[{role:n%2===0?"user":"assistant",content:`message ${n}`}]});
  await f.history.sync(f.root);
  assert.equal(f.history.total(),1300);
  assert.equal(f.history.read(url()).messages!.length,1300);
  const last=f.history.read(url("?limit=1"));
  assert.deepEqual(last.entries!.map(item=>item.index),[1298,1299]);
  assert.equal(last.total,1300);
  assert.equal(last.next,1298);
  const seen:number[]=[];
  for(let after=0;after<1300;) {
    const page=f.history.read(url(`?after=${after}&limit=125`));
    seen.push(...page.entries!.map(item=>item.index));
    assert.ok(page.nextAfter!>after);after=page.nextAfter!;
  }
  assert.deepEqual(seen,Array.from({length:1300},(_,i)=>i));
  const first=f.history.read(url("?after=0&limit=1"));
  assert.equal(first.entries![0].message.requestId,"r0");
  assert.deepEqual(first.entries![0].message.metadata,{n:0});
  f.reads.length=0;
  f.entries.push({id:1302,model:[{role:"user",content:"new"}]});
  await f.history.sync(f.root);
  assert.equal(f.history.total(),1301);
  assert.deepEqual(f.reads,[{from:1302,size:128}]);
});

test("byte-bounded pages split long turns without gaps and reject invalid cursors", async t=>{
  const f=fixture();t.after(()=>f.database.close());
  for(let n=0;n<40;n++) f.entries.push({id:n+1,model:[{role:n===0?"user":"assistant",content:"é".repeat(1400)}]});
  await f.history.sync(f.root);
  let after=0;const seen:number[]=[];
  while(after<40) {
    const page=f.history.read(url(`?after=${after}&limit=50&maxBytes=16384`));
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=16384);
    assert.equal(page.split,true);
    seen.push(...page.entries!.map(item=>item.index));after=page.nextAfter!;
  }
  assert.deepEqual(seen,Array.from({length:40},(_,i)=>i));
  assert.deepEqual(f.history.read(url("?after=99")),{entries:[],next:null,total:40,nextAfter:40,truncated:true});
  for(const query of ["?after=1&before=2","?limit=501","?maxBytes=16383","?before=-1"])
    assert.throws(()=>f.history.read(url(query)));
});
