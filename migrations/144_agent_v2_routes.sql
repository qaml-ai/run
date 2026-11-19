create table agent_v2_routes (
  tenant text not null,
  agent text not null,
  destination_tenant text not null,
  destination_agent text not null,
  event_base bigint not null,
  primary key (tenant, agent),
  foreign key (tenant, agent) references agent_v2_cutovers (tenant, agent),
  unique (destination_tenant, destination_agent)
);

create table agent_v2_requests (
  tenant text not null,
  agent text not null,
  request_id text not null,
  fingerprint text not null,
  primary key (tenant, agent, request_id),
  foreign key (tenant, agent) references agent_v2_routes (tenant, agent)
);
