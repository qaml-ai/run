-- Session-scoped Pi durable records. Range/head indexes make current-context reload
-- proportional to the active context, independent of archived conversation length.
create table pi_durable_metadata (
  session_id text primary key,
  singleton integer not null default 1 check (singleton = 1),
  next_id text not null,
  next_seq bigint not null
);
create table pi_durable_record_ids (
  session_id text not null, id bigint not null,
  record_type text not null check (record_type in ('conversation', 'entry', 'task', 'submission', 'document')),
  primary key (session_id, id)
);
create table pi_durable_conversations (
  session_id text not null, id bigint not null,
  owner_conversation_id bigint, owner_task_id bigint, record text not null,
  primary key (session_id, id)
);
create index pi_conversations_owner_conversation on pi_durable_conversations (session_id, owner_conversation_id, id);
create index pi_conversations_owner_task on pi_durable_conversations (session_id, owner_task_id, id);
create table pi_durable_entries (
  session_id text not null, id bigint not null, conversation_id bigint not null,
  head bigint, commit_seq bigint not null, record text not null,
  primary key (session_id, id)
);
create index pi_entries_conversation on pi_durable_entries (session_id, conversation_id, id desc);
create index pi_entry_heads on pi_durable_entries (session_id, conversation_id, id desc) where head is not null;
create table pi_durable_tasks (
  session_id text not null, id bigint not null, conversation_id bigint not null,
  kind text not null,
  status text not null check (status in ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
  abort_requested integer not null check (abort_requested in (0, 1)),
  background integer not null check (background in (0, 1)), record text not null,
  primary key (session_id, id)
);
create index pi_tasks_status on pi_durable_tasks (session_id, status, id);
create index pi_tasks_conversation on pi_durable_tasks (session_id, conversation_id, id);
create index pi_tasks_kind on pi_durable_tasks (session_id, kind, id);
create index pi_tasks_abort on pi_durable_tasks (session_id, abort_requested, id);
create index pi_tasks_background on pi_durable_tasks (session_id, background, id);
create table pi_durable_submissions (
  session_id text not null, id bigint not null, conversation_id bigint not null,
  request_id text,
  status text not null check (status in ('queued', 'placed', 'done', 'unanswered')),
  record text not null, primary key (session_id, id)
);
create index pi_submissions_request on pi_durable_submissions (session_id, conversation_id, request_id);
create index pi_submissions_conversation on pi_durable_submissions (session_id, conversation_id, id);
create index pi_submissions_status on pi_durable_submissions (session_id, status, id);
create table pi_durable_documents (
  session_id text not null, id bigint not null, kind text not null,
  family integer not null check (family in (0, 1)), key_value text not null,
  scope_kind text not null check (scope_kind in ('session', 'conversation', 'task')),
  owner_id bigint not null, created_at bigint not null, retired_at bigint,
  record text not null, primary key (session_id, id)
);
create index pi_documents_address on pi_durable_documents (session_id, kind, scope_kind, owner_id, family, key_value, created_at desc, retired_at);
create index pi_documents_scope on pi_durable_documents (session_id, scope_kind, owner_id, id);
create index pi_documents_scope_kind on pi_durable_documents (session_id, scope_kind, owner_id, kind, id);
create table pi_durable_document_revisions (
  session_id text not null, document_id bigint not null, seq bigint not null,
  kind text not null check (kind in ('base', 'delta')),
  version integer not null, content text not null,
  primary key (session_id, document_id, seq)
);
create index pi_document_revisions_kind on pi_durable_document_revisions (session_id, document_id, kind, seq desc);
