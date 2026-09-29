-- Model providers of a key scope (src/model-providers.ts): only that scope's agents call them, by the same
-- `<name>/<model id>`, before the tenant's of the same name. The tenant's own have scope ''.
alter table model_providers add column scope text not null default '';
alter table model_providers drop constraint model_providers_pkey;
alter table model_providers add primary key (tenant, scope, name);
