import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentHistory } from "../src/history.ts";

test("history commits each entry and cursor atomically and ignores context replacement", async t=>{
  const db=new DatabaseSync(":memory:");
  t.after(()=>db.close());
  let interrupt=false;
  const sql={exec(query:string,...params:unknown[]){
    if(interrupt && query.startsWith("INSERT INTO camel_history_cursor")) throw new Error("interrupted before cursor");
    const rows=db.prepare(query).all(...params as never);
    return Object.assign(rows,{toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}});
  }} as unknown as SqlStorage;
  const history=new AgentHistory(sql,write=>{
    db.exec("BEGIN");
    try{const result=write();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;}
  });
  const user=(content:string)=>({role:"user",content,timestamp:1});
  const reply=(text:string)=>({role:"assistant",content:[{type:"text",text}],timestamp:2});
  const entries=[
    {id:1,kind:"camel.prompt",data:{requestId:"first"},model:[user("one"),reply("first")]},
    {id:2,kind:"pi.reset",model:[user("not new history")]},
    {id:3,kind:"camel.context",model:[reply("context only")]},
    {id:4,kind:"camel.prompt",data:{requestId:"second"},model:[user("two"),reply("second")]},
  ];
  const root={async entries(query:{minEntryId:number}){return {items:entries.filter(entry=>entry.id>=query.minEntryId)}}} as never;
  interrupt=true;
  await assert.rejects(history.sync(root),/interrupted/);
  assert.equal(history.total(),0,"a failed cursor write leaves no partial history rows");
  interrupt=false;
  await history.sync(root);
  await history.sync(root);
  assert.equal(history.total(),4,"a retry or context reset never duplicates public messages");
  assert.deepEqual(history.tail(1).map(message=>message.content),[[{type:"text",text:"second"}]]);
  assert.deepEqual(history.tail(0),[]);
  const page=history.read(new URL("https://history/?after=2&limit=1"));
  assert.deepEqual(page.entries?.map(entry=>entry.index),[2,3]);
  assert.equal(page.nextAfter,4);
});
