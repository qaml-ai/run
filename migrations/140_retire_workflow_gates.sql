-- Workflows' gate() was removed (docs/design/workflow-simplification.md, cut 2): nothing reads an answer to a workflow's
-- inbox item any more, and its workflow ends failed (script_api_retired) the next time it runs. Its open items are
-- closed as expired, once, so no inbox shows a question nobody will read. Only workflows own such items (owner_kind
-- 'workflow', migration 137); an agent's items are untouched.
update agent_inputs
set state = 'expired',
    answer = jsonb_build_object('action', 'cancel', 'by', jsonb_build_object('system', 'expired'), 'at', (extract(epoch from now()) * 1000)::bigint),
    version = version + 1,
    updated_at = now()
where owner_kind = 'workflow' and state = 'pending';
