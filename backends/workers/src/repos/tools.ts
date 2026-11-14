import { repoHistory } from './history.ts';
import { RE2JS } from "re2js";
import { Buffer } from "node:buffer";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str, arr, bool, int } from "@earendil-works/pi-schema";
import { FileError, normalizePath } from "../file-errors.ts";
import { declaredType, sniffContentType } from "../file-policy.ts";
import { editArguments } from "../edit-arguments.ts";
import type { FileVersions } from "../file-versions.ts";
import type { RepoEnv } from "./registry.ts";
import { agentRepoId, workspaceMount, type Mount } from "./mounts.ts";
import { agentStore, insideRepo, globMatch } from "./agent-store.ts";
import { commitChanges, setRefToVersion, type WriteInput } from "./write.ts";
import type { PresentedRepoFile, WrittenRepoFile } from "./agent-files.ts";
import { heldFileError, lastSaved, readVmToolFile, resolveVmFiles, vmEntry, vmList, vmOperation, vmRepoPath, vmHeld, VmRouteError, type VmFilesProvider } from "./vm-route.ts";

const TOOL_READ_BYTES = 1024 * 1024;
export function repoTools(
  env: RepoEnv,
  tenant: string,
  agentId: string,
  getMounts: () => Promise<Mount[]> = async () => [
    { repo: agentRepoId(tenant, agentId), path: "/workspace", mode: "rw" },
  ],
  onPresent?: (file: PresentedRepoFile, path: string) => Promise<void>,
  onWrite?: (file: WrittenRepoFile) => Promise<void>,
  seen?: FileVersions,
  identity: Record<string,string> = {},
  vmFiles?: VmFilesProvider,
) {
  const mountPath = async (raw: string, write = false) => {
    const mounts = await getMounts();
    if (!mounts.length)
      throw new FileError("This agent has no volumes mounted");
    const path = normalizePath(
      raw.startsWith("/") ? raw : mounts[0].path + "/" + raw,
    );
    const mount = [...mounts]
      .sort((a, b) => b.path.length - a.path.length)
      .find((m) => path === m.path || path.startsWith(m.path + "/"));
    if (!mount) throw new FileError(`${path} is not inside a mount`);
    if (write && mount.mode !== "rw")
      throw new FileError("Mount is read-only", 403);
    const base = mount.subpath ?? "/";
    return {
      ref: mount.ref ?? "main",
      path: normalizePath(base + "/" + path.slice(mount.path.length)),
      mount,
      show: (p: string) =>
        mount.path +
        (base === "/" ? (p === "/" ? "" : p) : p.slice(base.length)),
    };
  };
  const resolve = (t: Awaited<ReturnType<typeof mountPath>>) =>
    resolveVmFiles(env, { tenant, agent: agentId, repo: t.mount.repo, ref: t.ref }, vmFiles);
  const store = (t: Awaited<ReturnType<typeof mountPath>>) =>
    agentStore(env, tenant, t.mount.repo, t.ref, agentId, identity);
  const target = async (raw: string, write = false) => {
    const t = await mountPath(raw, write);
    const vm = await resolve(t);
    return vm ? { ...t, vm, v: undefined } : { ...t, vm: undefined, v: await store(t) };
  };
  const refTarget = async (raw: string, write = false) => {
    const t = await mountPath(raw, write);
    const running = Boolean(await resolve(t));
    if (write && running) throw new VmRouteError(409, vmHeld(t.ref), "held");
    return { ...t, running, v: await store(t) };
  };
  const readFile = (t: Awaited<ReturnType<typeof target>>) =>
    t.vm ? readVmToolFile(t.vm, t.ref, t.path, TOOL_READ_BYTES) : t.v.read(t.path, undefined, TOOL_READ_BYTES);
  const listFiles = (t: Awaited<ReturnType<typeof target>>, pattern?: string) =>
    t.vm ? vmList(t.vm, t.ref, t.path, pattern) : t.v.list(t.path, undefined, pattern);
  const writeFile = async (t: Awaited<ReturnType<typeof target>>, bytes: Uint8Array, contentType: string, expected?: string) => {
    if (!t.vm) return t.v.write(t.path, bytes, contentType, expected);
    const vm = t.vm, path = vmRepoPath(t.path);
    const written = await vmOperation(t.ref, () => vm.write(path, bytes, { expectSha256: expected }));
    return { ...vmEntry(t.path, written), contentType };
  };
  const output = (value: unknown) => ({
    output: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  });
  const seenKey = (target: { mount: Mount; path: string; vm?: unknown }) => `${target.vm ? "vm:" : ""}${target.mount.repo}:${target.mount.ref ?? "main"}:${target.path}`;
  const stale = (target: { path: string; show(path: string): string }) =>
    new FileError(`${target.show(target.path)} changed since you last read it; read it again, then retry against its current content`, 412);
  const guard = async <T>(target: { path: string; ref?: string; show(path: string): string }, run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) {
      if ((error as { status?: number }).status === 412 || /FILE_412:/.test(String(error))) throw stale(target);
      throw heldFileError(error, target.ref) ?? error;
    }
  };
  return [
    defineTool({
      name: "read",
      description:
        "Read UTF-8 text from a persistent file in /workspace or a mounted volume.",
      replay: "safe",
      parameters: obj({
        path: str(),
        offset: opt(int()),
        limit: opt(int()),
        encoding: opt(str()),
        length: opt(int()),
      }),
      async execute({ path, offset, limit, encoding, length }) {
        const t = await target(path);
        const { file, bytes } = await readFile(t);
        seen?.remember(seenKey(t), file.blob);
        if (encoding === "base64") {
          const start = offset ?? 0,
            end = Math.min(bytes.length, start + (length ?? 16384));
          if (start < 0 || start > bytes.length)
            throw new FileError("Invalid offset");
          return output({
            path,
            version: file.version,
            size: file.size,
            contentType: file.contentType,
            offset: start,
            data: Buffer.from(bytes.subarray(start, end)).toString("base64"),
            ...(end < bytes.length ? { nextOffset: end } : {}),
          });
        }
        const lines = new TextDecoder().decode(bytes).split("\n"),
          start = (offset ?? 1) - 1,
          count = limit ?? 200;
        if (start < 0 || count < 1) throw new FileError("Invalid line window");
        const text = lines.slice(start, start + count).join("\n");
        const result = output(
          text +
            (start + count < lines.length
              ? `\n[Continue at line ${start + count + 1}]`
              : ""),
        );
        if (t.vm) result.output.push({ type: "text", text: JSON.stringify({ version: file.version }) });
        return result;
      },
    }),
    defineTool({
      name: "write",
      description:
        "Write UTF-8 text to a persistent file in /workspace or a writable mounted repo.",
      replay: "unsafe",
      parameters: obj({
        path: str(),
        content: opt(str()),
        text: opt(str()),
        encoding: opt(str()),
        contentType: opt(str()),
      }),
      async execute({ path, content, text, encoding, contentType }) {
        if (content === undefined && text === undefined)
          throw new FileError("content is required");
        const t = await target(path, true);
        const bytes = encoding === "base64"
          ? Buffer.from(content ?? text!, "base64")
          : new TextEncoder().encode(content ?? text);

        const entry = await guard(t, () => writeFile(
          t,
          bytes,
          declaredType(contentType) ??
            sniffContentType(
              new TextEncoder().encode(content ?? text).subarray(0, 512),
              t.path,
            ),
          seen?.get(seenKey(t)),
        ));
        seen?.remember(seenKey(t), entry.blob);
        await onWrite?.({ path: t.show(entry.path), version: entry.version, size: entry.size, contentType: entry.contentType });
        return { output: [{ type: "text", text: JSON.stringify(entry) }] };
      },
    }),
    defineTool({
      name: "ls",
      description:
        "List persistent files under a /workspace or mounted directory.",
      replay: "safe",
      parameters: obj({ path: opt(str()) }),
      async execute({ path }) {
        if (path === "/")
          return output({
            path: "/",
            entries: (await getMounts()).map((m) => ({
              name: m.path.slice(1),
              type: "directory",
              mode: m.mode,
            })),
          });
        const t = await target(
          path ?? (await getMounts())[0]?.path ?? "/workspace",
        );
        const files = await listFiles(t),
          entries = new Map<string, unknown>();
        for await (const file of files) {
          const rest = file.path.slice(t.path === "/" ? 1 : t.path.length + 1),
            name = rest.split("/")[0];
          if (!name) continue;
          entries.set(
            name,
            rest.includes("/")
              ? { name, type: "directory" }
              : {
                  name,
                  type: "file",
                  size: file.size,
                  contentType: file.contentType,
                },
          );
        }
        return output({ path: t.show(t.path), entries: [...entries.values()] });
      },
    }),
    defineTool({
      name: "present_file",
      description:
        "Hand a file you made to the user with your reply. Writing alone does not share it.",
      replay: "unsafe",
      parameters: obj({ path: str(), caption: opt(str()) }),
      async execute({ path, caption }) {
        const t = await target(path);
        if (caption && caption.length > 1000)
          throw new FileError("Caption exceeds 1000 characters");
        // One path for presented files: always a saved repo version. On a running machine, save first (the host
        // checkpoint, through the VM backend), then present the ref's version, so the link survives the machine's sleep.
        const file = t.vm
          ? await (async (vm) => {
            const { file } = await readVmToolFile(vm, t.ref, t.path);
            const saved = await vmOperation(t.ref, () => vm.checkpoint());
            return { ...file, version: saved.version };
          })(t.vm)
          : await t.v.stat(t.path);
        const presented: PresentedRepoFile = {
          type: "file",
          path: t.show(t.path),
          repo: t.mount.repo,
          repoPath: insideRepo(t.path),
          version: file.version,
          size: file.size,
          contentType: file.contentType,
          blob: file.blob,
          ...(caption ? { caption } : {}),
        };
        await onPresent?.(presented, t.path);
        return output({
          path: presented.path,
          version: file.version,
          size: file.size,
          contentType: file.contentType,
          presented: true,
        });
      },
    }),
    defineTool({
      name: "edit",
      description:
        "Replace exact text in a UTF-8 file. Each oldText must occur exactly once.",
      replay: "unsafe",
      parameters: obj({
        path: str(),
        edits: arr(obj({ oldText: str(), newText: str() })),
      }),
      // A top-level oldText/newText pair and other common shapes are repaired before validation, as Pi's edit does.
      prepareArguments: editArguments as never,
      async execute({ path, edits }) {
        const t = await target(path, true),
          { file, bytes } = await readFile(t);
        const expected = seen?.get(seenKey(t));
        if (expected !== undefined && expected !== file.blob) throw stale(t);
        seen?.remember(seenKey(t), file.blob);
        if (bytes.length > TOOL_READ_BYTES)
          throw new FileError("Tool file exceeds 1 MiB", 413);
        let text = new TextDecoder().decode(bytes);
        for (const edit of edits) {
          if (!edit.oldText || text.split(edit.oldText).length !== 2)
            throw new FileError("oldText must occur exactly once");
          text = text.replace(edit.oldText, edit.newText);
        }
        const edited = new TextEncoder().encode(text);

        const written = await guard(t, () => writeFile(
            t,
            edited,
            file.contentType,
            file.blob,
          ));
        seen?.remember(seenKey(t), written.blob);
        await onWrite?.({ path: t.show(written.path), version: written.version, size: written.size, contentType: written.contentType });
        return output(written);
      },
    }),
    defineTool({
      name: "glob",
      description:
        "Find files by *, ?, ** and {a,b} patterns relative to a mounted directory.",
      replay: "safe",
      parameters: obj({ pattern: str(), path: opt(str()), limit: opt(int()) }),
      async execute({ pattern, path, limit }) {
        const t = await target(path ?? (await getMounts())[0]?.path ?? "/workspace");
        const count = Math.max(1, Math.min(limit ?? 1000, 1000));
        const paths: string[] = [];
        for await (const file of await listFiles(t, pattern)) {
          if (paths.length === count) return output({ paths, truncated: true });
          paths.push(t.show(file.path));
        }
        return output({ paths });
      },
    }),
    defineTool({
      name: "grep",
      description:
        "Search UTF-8 file contents line by line for text, or with regex: true for a regular expression in RE2 syntax (no lookarounds or backreferences). Large and binary files are skipped.",
      replay: "safe",
      parameters: obj({
        pattern: str(),
        path: opt(str()),
        glob: opt(str()),
        regex: opt(bool()),
        ignoreCase: opt(bool()),
        limit: opt(int()),
      }),
      async execute({ pattern, path, glob, regex, ignoreCase, limit }) {
        if (!pattern || pattern.length > 512)
          throw new FileError("Invalid pattern");
        if(regex) {try {RE2JS.compile(pattern,ignoreCase?RE2JS.CASE_INSENSITIVE:0);}catch(e){throw new FileError(`Invalid regular expression: ${(e as Error).message}`);}}
        const t = await target(path ?? (await getMounts())[0]?.path ?? "/workspace");
        const prefix = insideRepo(t.path);
        const vm = t.vm;
        const repoPath = vm && prefix ? vmRepoPath(t.path) : prefix;
        const head = t.v ? await t.v.ctx.repo.ref(t.ref) : undefined;
        if (t.v && !head) return output({ matches: [] });
        let file = false;
        if (repoPath) {
          if (vm) file = Boolean((await vmOperation(t.ref, () => vm.stat([repoPath])))[repoPath]);
          else try { await t.v.stat(t.path); file = true; } catch (e) { if (!String(e).includes("FILE_404:")) throw e; }
        }
        const input = { tree: head?.tree ?? "", q: pattern, regex, ignoreCase, path: repoPath ? repoPath + (file ? "" : "/**") : undefined, limit: Math.max(1, Math.min(limit ?? 100, 1000)) };
        const result = vm
          ? await vmOperation(t.ref, () => vm.grep(input))
          : await t.v.ctx.storage.grep(t.v.ctx.lineage, input);
        return output({ ...result, matches: result.matches.filter(m => !glob || globMatch(m.path.slice(prefix ? prefix.length + 1 : 0), glob)).map(m => ({...m, path: t.show('/' + m.path)})) });
      },
    }),
    defineTool({
      name: "delete",
      description: "Delete a file from /workspace or a writable mounted repo.",
      replay: "unsafe",
      parameters: obj({ path: str() }),
      async execute({ path }) {
        const t = await target(path, true), p = vmRepoPath(t.path);
        const expected = seen?.get(seenKey(t));
        const expect = expected === undefined ? undefined : { [p]: expected };
        const version = await guard(t, async () => {
          if (t.vm) {
            const vm = t.vm;
            await vmOperation(t.ref, () => vm.delete([p], expect ? { expectSha256: expect } : undefined));
            return undefined;
          }
          return (await t.v.commit({ [p]: null }, expect, `delete ${p}`)).version;
        });
        seen?.remember(seenKey(t), "none");
        return output({ deleted: true, version });
      },
    }),
    ...(["cp", "mv"] as const).map((name) =>
      defineTool({
        name,
        description:
          "Copy or move files between mounted volumes. Directories require recursive for cp.",
        replay: "unsafe",
        parameters: obj({
          from: str(),
          to: str(),
          overwrite: opt(bool()),
          recursive: opt(bool()),
        }),
        async execute({ from, to, overwrite, recursive }) {
          const source = await refTarget(from, name === "mv"),
            destination = await refTarget(to, true);
          if (
            source.mount.repo === destination.mount.repo && source.v.ref === destination.v.ref &&
            (source.path === destination.path ||
              destination.path.startsWith(source.path + "/"))
          )
            throw new FileError(
              "Destination cannot be the source or inside it",
            );
          const files = await source.v.list(source.path, undefined, undefined, true);
          if (!files.length) throw new FileError("Source not found", 404);
          const directory = files[0].path !== source.path;
          if (directory && name === "cp" && !recursive)
            throw new FileError("Directory copies require recursive: true");
          if (files.length > 1000)
            throw new FileError("At most 1000 files", 413);
          for(const file of files) { const prior=seen?.get(`${source.mount.repo}:${source.v.ref}:${file.path}`); if(prior!==undefined&&prior!==file.blob)throw stale({...source,path:file.path}); }
          const sameRef = source.mount.repo === destination.mount.repo && source.v.ref === destination.v.ref;
          const changes: WriteInput['changes'] = {}, expected: Record<string,string> = {};
          for (const file of files) {
            const path = destination.path + file.path.slice(source.path.length), p = insideRepo(path);
            let destinationBlob:string|undefined;
            try { destinationBlob=(await destination.v.stat(path)).blob; if (!overwrite) throw new FileError("Destination exists", 409); }
            catch (e) { if (!String(e).includes("FILE_404:")) throw e; }
            changes[p] = { from: { repo: source.mount.repo, ref: source.v.ref, version:file.version, path: insideRepo(file.path) } };
            const previous = seen?.get(`${destination.mount.repo}:${destination.v.ref}:${path}`);
            expected[p] = previous ?? destinationBlob ?? 'none';
            if (name === "mv" && sameRef) { changes[insideRepo(file.path)] = null; expected[insideRepo(file.path)] = seen?.get(`${source.mount.repo}:${source.v.ref}:${file.path}`) ?? file.blob; }
          }
          const result = await guard(destination, () => destination.v.commit(changes, expected, `${name} ${from}`));
          if (name === "mv" && !sameRef) {
            const removals: WriteInput['changes'] = {}, sourceExpect: Record<string,string> = {};
            for (const file of files) { const p=insideRepo(file.path); removals[p]=null; sourceExpect[p]=seen?.get(`${source.mount.repo}:${source.v.ref}:${file.path}`) ?? file.blob; }
            await guard(source,()=>source.v.commit(removals,sourceExpect,`mv ${from}`));
          }
          if (name === 'mv') for (const file of files)
            seen?.remember(`${source.mount.repo}:${source.v.ref}:${file.path}`, 'none');
          for (const [path, entry] of Object.entries(result.files)) if (entry) {
            seen?.remember(`${destination.mount.repo}:${destination.v.ref}:/${path}`, entry.blob);
            await onWrite?.({ path: destination.show('/' + path), version: result.version!, size: entry.size, contentType: sniffContentType(new Uint8Array(), path) });
          }
          return output({ copied: files.length, moved: name === "mv" });
        },
      }),
    ),
    ...versionTools(refTarget, async () => workspaceMount(tenant, agentId, await getMounts()).path, output, agentId, identity),
  ];
}
function versionTools(
  target: (path: string, write?: boolean) => Promise<{ v: Awaited<ReturnType<typeof agentStore>>; path: string; mount: Mount; running: boolean }>,
  workspace: () => Promise<string>,
  output: (value: unknown) => { output: {type: 'text'; text: string}[] },
  agent: string,
  identity: Record<string,string>,
) {
  const committed = (t: { running: boolean; v: { ref: string } }, value: unknown) => {
    const result = output(value);
    if (t.running) result.output.push({ type: 'text', text: lastSaved(t.v.ref) });
    return result;
  };
  const explicitWrite = async <T>(ref: string, run: () => Promise<T>) => {
    try { return await run(); }
    catch (error) { throw heldFileError(error, ref) ?? error; }
  };
  const resolve = async (t: Awaited<ReturnType<typeof target>>, value: string) => {
    if (!/^[a-f0-9]{7,40}$/.test(value)) throw new FileError('Version must be an id or unique prefix of at least 7 hex characters');
    if (value.length === 40) return t.v.ctx.repo.resolve(value);
    const matches = new Set<string>();
    let after: string | undefined;
    do {
      const page = await repoHistory(t.v.ctx, { ref: t.v.ref, after, limit: 500 });
      for (const v of page.versions) if (v.version.startsWith(value)) matches.add(v.version);
      after = page.next ?? undefined;
    } while (after);
    if (matches.size !== 1) throw new FileError('Version prefix is missing or ambiguous');
    return await t.v.ctx.repo.resolve([...matches][0]);
  };
  return [
    defineTool({ name: 'checkpoint', description: 'Save a named version of your files now, such as "tests pass, before refactor". Your work is already saved automatically as you go; name a version when you may want to return to it with restore. Returns the version id. Costs nothing if nothing changed. path picks the mount (default: your workspace).', replay: 'unsafe', parameters: obj({message: str(), path: opt(str())}), async execute({message,path}) {
      const t = await target(path ?? await workspace(), true), head = await t.v.ctx.repo.ref(t.v.ref), previous = head && await t.v.ctx.repo.commit(head.version);
      // Naming the same point twice is free; a new name for it is a new (empty) commit, never a dropped message.
      if (previous?.trailers['Camel-Checkpoint'] === 'manual' && previous.message === message) return output(previous.version);
      return output((await explicitWrite(t.v.ref, () => commitChanges(t.v.ctx, {ref:t.v.ref, op:'turn', changes:{}, message, allowEmpty:true, author:`agent:${agent}`,who:`agent:${agent}`,why:'checkpoint',trailers:{'Camel-Agent':agent,...identity,'Camel-Checkpoint':'manual'}}))).version);
    }}),
    defineTool({ name: 'restore', description: "Put a mount's files back to an earlier version (an id or prefix from history). This adds a new version, so nothing is lost and you can restore again.", replay:'unsafe',parameters:obj({version:str(),path:opt(str())}),async execute({version,path}) {
      const t = await target(path ?? await workspace(),true), v=await resolve(t,version);
      return output((await explicitWrite(t.v.ref, () => setRefToVersion(t.v.ctx,{ref:t.v.ref,version:v.version,newCommit:true,author:`agent:${agent}`,who:`agent:${agent}`,why:'restore',trailers:{'Camel-Agent':agent,...identity,'Camel-Checkpoint':'automatic'}}))).version);
    }}),
    defineTool({name:'history',description:"List a mount's versions, newest first. With a file path, only versions that changed it. Pass next as after to continue.",replay:'safe',parameters:obj({path:opt(str()),limit:opt(int()),after:opt(str())}),async execute({path,limit,after}) {
      const t = await target(path ?? await workspace());
      return committed(t, await repoHistory(t.v.ctx, { ref: t.v.ref, path: insideRepo(t.path) || undefined, limit, after }));
    }}),
    defineTool({name:'diff',description:'List the files that changed between two versions. By default, between the previous version and now.',replay:'safe',parameters:obj({from:opt(str()),to:opt(str()),path:opt(str())}),async execute({from,to,path}) {
      const t=await target(path ?? await workspace()), head=await t.v.ctx.repo.resolve(t.v.ref), current=await t.v.ctx.repo.commit(head.version);
      const a=from ? await resolve(t,from) : current?.parents[0] ? await t.v.ctx.repo.resolve(current.parents[0]) : {tree:'4b825dc642cb6eb9a060e54bf8d69288fbee4904'}, b=to ? await resolve(t,to) : head;
      const d=await t.v.ctx.storage.diff(t.v.ctx.lineage,a.tree,b.tree);
      const prefix=insideRepo(t.mount.subpath??'/');
      return committed(t, d.changes.filter(c=>!prefix||c.path===prefix||c.path.startsWith(prefix+'/')).map(c=>`${c.status} ${c.path}`).join('\n'));
    }}),
  ];
}
