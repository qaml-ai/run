import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Agents } from "../../../clients/agents.ts";
import { startFixture } from "./fixture.ts";

test("custom provider declarations, credentials, scopes and live routing", {timeout:180000}, async t => {
  const calls: {headers:Record<string,unknown>;body:any}[] = [];
  const provider = createServer(async (req,res) => {
    let data="";
    for await (const part of req) data+=part;
    const body=JSON.parse(data);
    calls.push({headers:req.headers,body});
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const send=(delta:unknown,finish_reason:string|null=null) => res.write(`data: ${JSON.stringify({id:"provider-test",object:"chat.completion.chunk",created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    if (body.tools?.some((tool:any)=>tool.function?.name==="final_output")) {
      send({role:"assistant",tool_calls:[{index:0,id:"output-1",type:"function",function:{name:"final_output",arguments:JSON.stringify({answer:42})}}]}); send({},"tool_calls");
    } else { send({role:"assistant",content:"Local provider answer"}); send({},"stop"); }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const baseUrl=`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`;
  const fixture=await startFixture({vars:{TEST_MODEL:"0",MODEL:"openai/gpt-4o-mini"}});
  t.after(() => fixture.stop());
  const request=async(path:string,body?:unknown,method=body===undefined?"GET":"PUT") => {
    const response=await fetch(fixture.url+path,{method,headers:{Authorization:`Bearer ${fixture.token}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json() as any;
    assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const config={type:"openai-completions",baseUrl,models:[{id:"fixture-model",contextWindow:32768,maxOutputTokens:1024}]};
  const own=await request("/v1/providers/fixture",config);
  assert.equal(own.custom.models[0].id,"fixture-model");
  assert.equal(own.key,null);
  const models=await request("/v1/models?provider=fixture&available=true");
  assert.equal(models[0].id,"fixture/fixture-model");
  assert.equal(models[0].contextWindow,32768);
  const agents=new Agents({url:fixture.url,apiKey:fixture.token,connection:"lazy",pollMs:10});
  t.after(() => agents.close());
  const agent=await agents.upsert("provider-test",{model:"fixture/fixture-model",codeMode:false,fileTools:false,temperature:0.3,maxOutputTokens:123});
  const first = await agent.run("hello",{timeoutMs:15000,throwOnError:false});
  assert.equal(first.status,"completed",JSON.stringify(first.error));
  assert.equal(first.text,"Local provider answer");
  assert.equal(calls[0].body.model,"fixture-model");
  assert.equal(calls[0].headers.authorization,undefined);
  assert.equal(calls[0].body.temperature,0.3);
  assert.equal(calls[0].body.max_tokens??calls[0].body.max_completion_tokens,123);
  await fixture.worker.stop(true);
  await fixture.worker.start();
  assert.equal((await agent.run("after restart",{timeoutMs:15000})).text,"Local provider answer");
  const output={type:"object" as const,properties:{answer:{type:"integer" as const}},required:["answer"],additionalProperties:false};
  const structured=await agent.run("structured",{output,timeoutMs:15000});
  assert.deepEqual(structured.output,{answer:42});
  assert.deepEqual(calls.at(-1)?.body.tools.find((tool:any)=>tool.function?.name==="final_output").function.parameters,output);
  assert.equal(calls.at(-1)?.body.tool_choice.function.name,"final_output");
  const keyed=await request("/v1/providers/fixture",{...config,apiKey:"fixture-secret-1234",headers:{"X-Fixture":"sealed-header-value"}});
  assert.equal(keyed.key.last4,"1234");
  assert.equal(JSON.stringify(await request("/v1/providers")).includes("fixture-secret"),false);
  const rows=(await fixture.db.query("select config,sealed from model_providers where name='fixture'")).rows;
  assert.equal(JSON.stringify(rows).includes("fixture-secret"),false);
  assert.equal(JSON.stringify(rows).includes("sealed-header-value"),false);
  await agent.run("again",{timeoutMs:15000});
  assert.equal(calls.at(-1)?.headers.authorization,"Bearer fixture-secret-1234");
  assert.equal(calls.at(-1)?.headers["x-fixture"],"sealed-header-value");
  await request("/v1/providers/fixture",config);
  await agent.run("kept",{timeoutMs:15000});
  assert.equal(calls.at(-1)?.headers.authorization,"Bearer fixture-secret-1234");
  await request("/v1/key-scopes/customer/model-providers/fixture",{...config,apiKey:"fixture-scope-5678"});
  assert.equal((await request("/v1/key-scopes/customer/model-providers"))[0].key.last4,"5678");
  const scoped=await agents.upsert("scoped-provider",{model:"fixture/fixture-model",keyScope:"customer",codeMode:false,fileTools:false});
  await scoped.run("scope",{timeoutMs:15000});
  assert.equal(calls.at(-1)?.headers.authorization,"Bearer fixture-scope-5678");
  await request("/v1/providers/fixture",{...config,apiKey:null,headers:null});
  await agent.run("cleared",{timeoutMs:15000});
  assert.equal(calls.at(-1)?.headers.authorization,undefined);
  assert.equal(calls.at(-1)?.headers["x-fixture"],undefined);
  await request("/v1/providers/fixture",undefined,"DELETE");
  const missing=await fetch(fixture.url+"/v1/providers/fixture",{method:"DELETE",headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.equal(missing.status,404);
});

test("custom Responses and Anthropic APIs preserve native protocols and authentication", {timeout:180000}, async t => {
  const requests:{path:string;headers:Record<string,any>}[]=[];
  const server=createServer(async(req,res)=>{
    let data="";for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);requests.push({path:req.url!,headers:req.headers});
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const send=(event:any)=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if(body.input!==undefined){
      const item={id:"msg_1",type:"message",role:"assistant",content:[{type:"output_text",text:"Via Responses."}]};
      send({type:"response.created",response:{id:"resp_1",status:"in_progress"}});
      send({type:"response.output_item.added",output_index:0,item:{...item,content:[]}});
      send({type:"response.output_text.delta",output_index:0,content_index:0,delta:"Via Responses."});
      send({type:"response.output_item.done",output_index:0,item});
      send({type:"response.completed",response:{id:"resp_1",status:"completed",usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});
    }else{
      send({type:"message_start",message:{id:"msg_1",type:"message",role:"assistant",model:"house",content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:1}}});
      send({type:"content_block_start",index:0,content_block:{type:"text",text:""}});
      send({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Via Messages."}});
      send({type:"content_block_stop",index:0});
      send({type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:5}});
      send({type:"message_stop"});
    }
    res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const provider={url:`http://127.0.0.1:${(server.address() as {port:number}).port}/llm`,requests};
  const fixture=await startFixture({vars:{TEST_MODEL:"0",MODEL:"openai/gpt-4o-mini"}});
  t.after(()=>fixture.stop());
  const agents=new Agents({url:fixture.url,apiKey:fixture.token,connection:"lazy",pollMs:10});
  t.after(()=>agents.close());
  const put=async(name:string,type:string,auth?:string) => {
    const response=await fetch(`${fixture.url}/v1/providers/${name}`,{method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"Content-Type":"application/json"},body:JSON.stringify({type,baseUrl:provider.url,apiKey:"fixture-provider-key",...(auth?{auth}:{}),models:[{id:"house",contextWindow:32768}]})});
    assert.equal(response.status,200);
  };
  await put("responses","openai-responses");
  const responseAgent=await agents.upsert("responses",{model:"responses/house",fileTools:false,codeMode:false});
  assert.equal((await responseAgent.run("hello",{timeoutMs:15000})).text,"Via Responses.");
  assert.match(provider.requests.at(-1)!.path,/\/responses$/);
  assert.equal(provider.requests.at(-1)!.headers.authorization,"Bearer fixture-provider-key");
  await put("messages","anthropic-messages","bearer");
  const messageAgent=await agents.upsert("messages",{model:"messages/house",fileTools:false,codeMode:false});
  assert.equal((await messageAgent.run("hello",{timeoutMs:15000})).text,"Via Messages.");
  assert.match(provider.requests.at(-1)!.path,/\/v1\/messages/);
  assert.equal(provider.requests.at(-1)!.headers.authorization,"Bearer fixture-provider-key");
  assert.equal(provider.requests.at(-1)!.headers["x-api-key"],undefined);
  await put("messages","anthropic-messages");
  assert.equal((await messageAgent.run("again",{timeoutMs:15000})).text,"Via Messages.");
  assert.equal(provider.requests.at(-1)!.headers.authorization,undefined);
  assert.equal(provider.requests.at(-1)!.headers["x-api-key"],"fixture-provider-key");
});

test("first-token and idle stream timeouts terminate stalled providers", {timeout:180000}, async t => {
  let mode:"first"|"idle"="first", calls=0;
  const server=createServer(async(req,res)=>{
    for await(const _chunk of req){};
    calls++;
    if(mode==="idle"){
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      res.write(`data: ${JSON.stringify({id:"stalled",object:"chat.completion.chunk",created:1,model:"house",choices:[{index:0,delta:{role:"assistant",content:"partial"},finish_reason:null}]})}\n\n`);
    }
    // Deliberately leave both the response and model output unfinished.
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const fixture=await startFixture({vars:{TEST_MODEL:"0",MODEL:"openai/gpt-4o-mini"}});
  t.after(()=>fixture.stop());
  const configured=await fetch(`${fixture.url}/v1/providers/stalled`,{method:"PUT",headers:{Authorization:`Bearer ${fixture.token}`,"Content-Type":"application/json"},body:JSON.stringify({type:"openai-completions",baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,models:[{id:"house",contextWindow:32768}]})});
  assert.equal(configured.status,200);
  const agents=new Agents({url:fixture.url,apiKey:fixture.token,connection:"lazy",pollMs:10});
  t.after(()=>agents.close());
  const agent=await agents.upsert("stalled",{model:"stalled/house",codeMode:false,fileTools:false,runLimits:{firstTokenSeconds:1,idleSeconds:1}});
  const first=await agent.run("no headers",{timeoutMs:20000,throwOnError:false});
  assert.equal(first.error?.code,"model_stream_stalled");
  assert.match(first.error?.message??"",/before its first token/);
  assert.ok(calls>=1);
  mode="idle";
  const idle=await agent.run("stops mid-answer",{timeoutMs:20000,throwOnError:false});
  assert.equal(idle.error?.code,"model_stream_stalled");
  assert.match(idle.error?.message??"",/mid-response/);
});
