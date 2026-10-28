### Converting legacy history formats

`POST /v1/operations/legacy-migrate` (platform operator token only) converts each agent legacy coverage counts to the
current history format with the legacy readers one last time: a host transcript never retired is retired; a journal with
no journal history, or a legacy log with no journal, has its history indexed whole and a base and context checkpoint
written after it; a retired session's index short of its base is filled from the host's records. A dry run by default.
It walks agents in batches for about 20 s per call with a cursor, converts one agent at a time under its own claim
(agents loaded, held by a live node, or with runs open are skipped), measures each agent's stored history first and
reports one past `maxBytes` (16 MiB by default, at most 64 MiB) without reading it, and answers a result code per agent.
A load that retires an agent itself meanwhile waits for the conversion on its node, or is skipped by it on another.

Legacy coverage now finds host transcripts by their host document (imports before #322 had their host generation after
their archive), counts journals with no base document (`pi_without_base_document`) and legacy logs folded to Storage
(`no_pi_with_legacy_log_objects`, listed), treats Pi storage with no entries as no journal, and blocks its gate on every
legacy count; `gate.ready` also needs Storage listed. See `docs/operations/pi-durable.md`.
