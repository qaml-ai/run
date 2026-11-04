// Explicitly scoped Wrangler runner for the disposable cloud experiment.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const [action, filename] = process.argv.slice(2);
if (!['deploy-private', 'secret', 'enable', 'disable', 'delete', 'dry-run'].includes(action)) throw new Error('Unknown action');
const path = resolve(filename);
const source = JSON.parse(await readFile(path, 'utf8'));
const prefix = 'camelrun-proto-';
const names = [source.name, ...(source.durable_objects?.bindings ?? []).flatMap(x => [x.class_name, x.script_name].filter(Boolean)),
  ...(source.migrations ?? []).flatMap(x => [...x.new_sqlite_classes ?? [], ...x.deleted_classes ?? []]),
  ...(source.r2_buckets ?? []).map(x => x.bucket_name),
  ...(source.containers ?? []).flatMap(x => [x.name, x.class_name])];
if (source.account_id !== '85bbd288051330fb51ee1c86031a299b' || names.some(n => !n.startsWith(prefix))) throw new Error('Resource outside approved scope');
if ((source.migrations ?? []).some(m => Object.keys(m).some(k => !['tag','new_sqlite_classes','deleted_classes'].includes(k)))) throw new Error('Unsupported migration operation');
if (source.routes?.length || source.route || source.services?.length || source.kv_namespaces?.length || source.d1_databases?.length || source.queues) throw new Error('Unexpected resource binding');
const state = resolve(here, '.state');
await mkdir(state, {recursive:true});
const config = {...source, main: resolve(dirname(path), source.main), workers_dev: action === 'enable', preview_urls:false};
if (config.containers) config.containers = config.containers.map(c => ({...c, images:Object.fromEntries(Object.entries(c.images).map(([name, image])=>[name,{...image,dockerfile:resolve(dirname(path),image.dockerfile), ...(image.build_context ? {build_context:resolve(dirname(path),image.build_context)} : {})}]))}));
const runtimeConfig = resolve(state, basename(filename));
await writeFile(runtimeConfig, JSON.stringify(config,null,2));
const args = ['node_modules/wrangler/bin/wrangler.js'];
if (action === 'secret') args.push('secret','put','API_TOKEN','--config',runtimeConfig);
else if (action === 'delete') args.push('delete',source.name,'--config',runtimeConfig,'--force');
else args.push('deploy','--config',runtimeConfig,'--outdir',resolve(state,`${source.name}-bundle`), '--durable-objects-code-update-mode','immediate', ...(action === 'dry-run' ? ['--dry-run'] : []), ...(['enable','disable'].includes(action) && config.containers ? ['--containers-rollout','none'] : []));
await appendFile(resolve(state,'ledger.jsonl'),JSON.stringify({at:new Date().toISOString(),action,name:source.name,status:'starting'})+'\n');
const child = spawn(process.execPath,args,{cwd:resolve(here,'..'),stdio:['pipe','inherit','inherit'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(state,'logs')}});
child.stdin.end(action==='secret' ? await readFile(resolve(state,'api-token')) : 'y\n');
const code = await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
await appendFile(resolve(state,'ledger.jsonl'),JSON.stringify({at:new Date().toISOString(),action,name:source.name,status:code===0?'succeeded':'failed',code})+'\n');
process.exitCode = code ?? 1;
