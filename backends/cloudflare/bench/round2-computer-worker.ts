import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { authorized } from "../src/validation.ts";

interface Env { API_TOKEN: string; LOADER: WorkerLoader; SYNC: DurableObjectNamespace<SyncComputer> }
class SyncComputer extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly instanceId = crypto.randomUUID();
  readonly backend = new ContainerBackend({
    id: "container", container: () => this,
    workspace: { binding: "SYNC", id: this.ctx.id.toString() },
    egress: { mode: "none" }, name: "workspace", instance: "standard-2",
    heartbeatIntervalMs: 1000,
  });
  readonly workspace = new Workspace({ storage: this.ctx.storage, output: false, backends: [
    new WorkerShellBackend({ id: "worker-shell", loader: this.env.LOADER, ctx: this.ctx,
      workspace: { binding: "SYNC", id: this.ctx.id.toString() } }), this.backend,
  ] });
  __getWorkspaceStub() { return this.workspace.stub(); }
  fetch(request: Request) { return this.backend.handleFetch(request); }
  async operate(input: { op: string; id?: string; path?: string; text?: string; command?: string; backend?: string; sync?: "wait" | "defer"; timeoutMs?: number; idleMs?: number }) {
    const started = performance.now();
    let result: unknown;
    try {
      if (input.op === "status") result = { instanceId: this.instanceId, storageBytes: this.ctx.storage.sql.databaseSize,
        container: await this.getWorkspaceContainer().status(), backends: this.workspace.runtime.backends() };
      else if (input.op === "runs") {
        result = [...this.ctx.storage.sql.exec("SELECT execution_key, runtime_id FROM computer_execution_runtime")];
      } else if (input.op === "result") {
        if (!input.id || input.id.length > 200) throw new Error("Invalid execution id");
        const handle = await this.workspace.runtime.getExec(input.id, { backend:"container", encoding:"utf8", resume:"full" });
        result = await handle.result();
      } else if (input.op === "write") {
        if (!input.path?.startsWith("/workspace/") || input.path.split("/").includes("..") || (input.text?.length ?? 0) > 1_000_000) throw new Error("Invalid file");
        await this.workspace.fs.mkdir(input.path.slice(0,input.path.lastIndexOf("/")), {recursive:true});
        await this.workspace.fs.writeFile(input.path, input.text ?? ""); result = {written:input.path};
      } else if (input.op === "read") {
        if (!input.path?.startsWith("/workspace/") || input.path.split("/").includes("..")) throw new Error("Invalid file");
        result = {text: await this.workspace.fs.readFile(input.path, {encoding:"utf8"})};
      } else if (input.op === "exec") {
        if (!input.command || input.command.length > 100_000 || !["worker-shell","container"].includes(input.backend ?? "worker-shell")) throw new Error("Invalid command");
        const handle = await this.workspace.runtime.exec(input.command, {backend:input.backend ?? "worker-shell", cwd:"/workspace", encoding:"utf8", timeoutMs:Math.min(input.timeoutMs ?? 120000,300000), sync:input.sync ?? "wait"});
        result = await handle.result();
      } else if (input.op === "pull" || input.op === "push") {
        const progress: unknown[] = [];
        for await (const item of this.workspace[input.op]("container")) progress.push(item);
        result = {progress};
      } else if (input.op === "idle") {
        await this.getWorkspaceContainer().setInactivityTimeout(Math.max(1000, input.idleMs ?? 1000)); result = {set:true};
      } else if (input.op === "stop") {
        await this.ctx.container!.destroy(); result = {stopped:true};
      } else if (input.op === "close") {
        await this.workspace.close(); await this.ctx.container!.destroy(); result = {closed:true};
      } else throw new Error("Invalid operation");
      return {ok:true, op:input.op, elapsedMs:performance.now()-started, result};
    } catch (error) { return {ok:false, op:input.op, elapsedMs:performance.now()-started,
      error:error instanceof Error ? error.message : String(error), code:(error as {code?:string}).code}; }
  }
}
export { SyncComputer as "camelrun-proto-r2-sync", WorkspaceProxy, WorkspaceServiceProxy };
export default { async fetch(request:Request, env:Env) {
  if (!await authorized(request,env.API_TOKEN)) return Response.json({error:"Unauthorized"},{status:401});
  const match = /^\/workspace\/([a-z0-9-]{1,60})$/.exec(new URL(request.url).pathname);
  if (!match || request.method !== "POST") return Response.json({error:"Not found"},{status:404});
  const input = await request.json() as Parameters<SyncComputer["operate"]>[0];
  return Response.json(await env.SYNC.getByName(match[1]).operate(input));
} } satisfies ExportedHandler<Env>;
