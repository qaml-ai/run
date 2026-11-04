// Offline fixture preparation. This reads only the prototype and installed
// dependencies, never credentials, a home directory, or the parent runtime.
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const bench = dirname(fileURLToPath(import.meta.url));
const backend = resolve(bench, "..");
const output = await mkdtemp(join(tmpdir(), "camelrun-proto-computer-"));
const large = join(output, "large");
await mkdir(large);
await mkdir(join(output,"small"));
const allowed = name => !/^\.env(?:\.|$)|^\.npmrc$|^\.aws$|^\.git$/.test(name);
for (const name of ["package.json","package-lock.json","src","test"]) {
  await cp(join(backend,name), join(output,"small",name), {recursive:true, verbatimSymlinks:true, filter:source => allowed(source.split("/").at(-1))});
}
await cp(join(output,"small"), large, {recursive:true, verbatimSymlinks:true});
await cp(join(backend,"node_modules"),join(large,"node_modules"),{recursive:true, verbatimSymlinks:true, filter:source => allowed(source.split("/").at(-1))});
async function scan(path) {
  let bytes = 0, files = 0;
  for (const item of await readdir(path,{withFileTypes:true})) {
    const target = join(path,item.name);
    if (item.isDirectory()) {const child=await scan(target); bytes+=child.bytes; files+=child.files;}
    else if (item.isFile()) {bytes+=(await lstat(target)).size; files++;}
  }
  return {bytes,files};
}
const smallStats = await scan(join(output,"small"));
const largeStats = await scan(large);
const modulesStats = await scan(join(large,"node_modules"));
if (modulesStats.bytes < 300*1024*1024 || modulesStats.bytes > 650*1024*1024) throw new Error(`Installed dependencies outside the expected realistic 300–650 MiB range: ${modulesStats.bytes}`);
const manifest = {createdAt:new Date().toISOString(), source:"backends/cloudflare installed package and source", networkDownloads:false,
  small:smallStats, large:largeStats, nodeModules:modulesStats,
  limitation:"The installed dependency tree was prepared on macOS. The execution workload uses pure JavaScript TypeScript transpilation; native optional dependencies are not executed."};
await writeFile(join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
await promisify(execFile)("tar",["-cf",join(output,"large.tar"),"-C",large,"."],{timeout:120_000});
await cp(join(bench,"computer-fixture.mjs"),join(output,"fixture.mjs"));
await cp(join(bench,"computer-Dockerfile"),join(output,"Dockerfile"));
const config = JSON.parse(await readFile(join(bench,"computer-wrangler.jsonc"),"utf8"));
config.$schema=join(backend,"node_modules/wrangler/config-schema.json");
config.main=join(bench,"computer-entry.ts");
for (const container of config.containers) container.images.workspace={dockerfile:join(output,"Dockerfile"),build_context:output};
await writeFile(join(output,"computer-wrangler.jsonc"),JSON.stringify(config,null,2)+"\n");
console.log(JSON.stringify({output,config:join(output,"computer-wrangler.jsonc"),...manifest},null,2));
