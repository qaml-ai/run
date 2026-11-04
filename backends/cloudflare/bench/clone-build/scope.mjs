export const account='85bbd288051330fb51ee1c86031a299b';
export const prefix='camelrun-proto-bench-';
const resourceName=value=>typeof value==='string'&&/^camelrun-proto-bench-[a-z0-9-]+$/.test(value);

export function retirementScope(config){
 if(config.account_id!==account||!resourceName(config.name)||!Array.isArray(config.migrations)||!config.migrations.length)throw new Error('Outside benchmark scope');
 const classes=[];
 for(const migration of config.migrations){
  // Only the new SQLite classes created by these benchmark configs are replayed.
  // In particular, never replay arbitrary transfers, renames or deletions.
  if(Object.keys(migration).some(key=>!['tag','new_sqlite_classes'].includes(key))||!resourceName(migration.tag)||!Array.isArray(migration.new_sqlite_classes)||!migration.new_sqlite_classes.length||migration.new_sqlite_classes.some(name=>!resourceName(name)))throw new Error('Unsupported benchmark migration');
  classes.push(...migration.new_sqlite_classes);
 }
 if(new Set(classes).size!==classes.length)throw new Error('Duplicate benchmark class');
 const containers=config.containers??[];
 if(!Array.isArray(containers)||containers.some(container=>!resourceName(container.name)||!classes.includes(container.class_name)||container.scheduling_policy!=='durable_object'))throw new Error('Outside benchmark container scope');
 return {classes,names:containers.map(container=>container.name)};
}

export function registryTarget(repository,tag){
 const clean=repository.replace(/^\/+/, '');
 if(!new RegExp(`^${account}/${prefix}[a-z0-9][a-z0-9._-]*$`).test(clean)||typeof tag!=='string'||!(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)||/^sha256:[a-f0-9]{64}$/.test(tag)))throw new Error('Outside benchmark image scope');
 return `https://registry.cloudflare.com/v2/${clean}/manifests/${tag}`;
}
