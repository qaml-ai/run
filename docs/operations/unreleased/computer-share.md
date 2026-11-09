### Sub-agents share their parent's computer by default

New inline and definition children use the parent's machine and filesystem concurrently.
Children cannot start, stop or replace it. Their activity keeps it active, and billing
stays with its owner. Grandchildren share the same machine. Without a parent computer,
children get none; definitions with their own computer and existing targets keep it.
Use `computer: "none"`, `"fresh"` or `"fork"` to opt out of sharing.

Root agent trees may run four machines concurrently by default. `computerLimit`
on a definition or agent overrides the tenant default (1–64). Shared children use
no extra slot. New starts at the cap are refused without stopping running machines.
