/** Durable replay for run streams: a subscriber joins first, then replays through a fixed cursor. */
export class DurableEventLog {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS camel_events (cursor INTEGER PRIMARY KEY, request_id TEXT, body TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS camel_events_request ON camel_events(request_id,cursor)");
  }
  append(cursor: number, value: unknown) {
    const event=value as {type?:string;requestId?:string;id?:string};
    const id=event.requestId ?? (event.type==="response" ? event.id : undefined);
    // Single-use run sessions are purged at retention; long-lived agents keep their own history instead.
    if (id?.startsWith("run_")) this.sql.exec("INSERT OR IGNORE INTO camel_events(cursor,request_id,body) VALUES(?,?,?)",cursor,id,JSON.stringify(value));
  }
  read(id:string,after:number,before:number,limit=128):{cursor:number;body:string}[] {
    return [...this.sql.exec<{cursor:number;body:string}>("SELECT cursor,body FROM camel_events WHERE request_id=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?",id,after,before,limit)];
  }
}

export function runEventStream(request:Request, id:string, log:DurableEventLog, subscribe:(receive:(cursor:number,value:unknown)=>void)=>()=>void):Response {
  const raw=request.headers.get("Last-Event-ID") ?? "0", after=Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after)) return Response.json({error:"Invalid Last-Event-ID"},{status:400});
  const encoder=new TextEncoder();
  let cursor=after, closed=false, pulse=false, page:{cursor:number;body:string}[]=[];
  let waiting:(()=>void)|undefined;
  const wake=()=>{waiting?.();waiting=undefined;};
  const detach=subscribe((_next,value)=>{
    const event=value as {type?:string;requestId?:string;id?:string};
    if(event.requestId===id || event.type==="response" && event.id===id)wake();
  });
  const heartbeat=setInterval(()=>{pulse=true;wake();},10000);
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(heartbeat);detach();wake();};
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){
      while(!closed){
        if(!page.length)page=log.read(id,cursor,Number.MAX_SAFE_INTEGER);
        const row=page.shift();
        if(row){
          cursor=row.cursor;
          controller.enqueue(encoder.encode(`id: ${row.cursor}\ndata: ${row.body}\n\n`));
          if((JSON.parse(row.body) as {type?:string}).type==="response"){cleanup();controller.close();}
          return;
        }
        if(pulse){pulse=false;controller.enqueue(encoder.encode(": heartbeat\n\n"));return;}
        await new Promise<void>(resolve=>{waiting=resolve;});
      }
    },
    cancel(){cleanup();},
  });
  return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store"}});
}
