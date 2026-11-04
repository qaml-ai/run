// Runs inside the image. No command below uses network access.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const [op,kind="small"] = process.argv.slice(2);
const root="/workspace/repo";
if (!["small","large"].includes(kind)) throw new Error("Unknown fixture");
if (op === "prepare") {
  rmSync(root,{recursive:true,force:true}); mkdirSync(root,{recursive:true});
  if (kind === "small") cpSync("/opt/fixtures/small",root,{recursive:true});
  else execFileSync("tar",["-xf","/opt/fixtures/large.tar","-C",root],{timeout:180_000});
  writeFileSync("/workspace/marker.txt",`camelrun-proto-${kind}`);
  console.log(JSON.stringify({kind,...scan(root),nodeModules:existsSync(join(root,"node_modules"))}));
} else if (op === "verify") {
  if (readFileSync("/workspace/marker.txt","utf8")!==`camelrun-proto-${kind}`) throw new Error("Restored marker mismatch");
  const stats=scan(root);
  const expected=JSON.parse(readFileSync("/opt/fixtures/manifest.json","utf8"))[kind];
  if (stats.bytes!==expected.bytes || stats.files!==expected.files) throw new Error(`Fixture mismatch: ${JSON.stringify({stats,expected})}`);
  console.log(JSON.stringify({verified:true,kind,...stats,marker:`camelrun-proto-${kind}`}));
} else if (op === "work") {
  let files=0, bytes=0;
  const hash=createHash("sha256");
  const ts=kind==="large"?createRequire(join(root,"package.json"))("typescript"):null;
  function visit(path) {
    for (const entry of readdirSync(path,{withFileTypes:true})) {
      const name=join(path,entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && name.endsWith(".ts")) {
        const source=readFileSync(name,"utf8"); files++; bytes+=Buffer.byteLength(source);
        hash.update(ts?ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText:source);
      }
    }
  }
  visit(join(root,"src"));
  console.log(JSON.stringify({kind,files,bytes,sha256:hash.digest("hex"),transpiled:!!ts}));
} else if (op === "dirty") {
  writeFileSync("/workspace/marker.txt","dirty");
  rmSync(join(root,"src"),{recursive:true,force:true});
  console.log(JSON.stringify({dirty:true}));
} else throw new Error("Unknown operation");

function scan(path) {
  let bytes=0,files=0;
  for(const entry of readdirSync(path,{withFileTypes:true})) {
    const name=join(path,entry.name);
    if(entry.isDirectory()) {const next=scan(name);bytes+=next.bytes;files+=next.files;}
    else if(entry.isFile()) {bytes+=statSync(name).size;files++;}
  }
  return {bytes,files};
}
