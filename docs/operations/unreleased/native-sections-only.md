### Native Pi system sections for every agent

`AGENT_NATIVE_SECTIONS_TENANTS` is gone: every agent's system sections are native Pi sections, as they have been in
production (`*`) since the canary finished. The non-native path, which gave Pi's generation the host's sections in place
of its agent's through the task override, is removed. A conversation still under the old `instructions` key is re-keyed
to `application` as it loads, with the same prompt text, as before. Self-hosted nodes that left the variable unset now
render sections natively too; the variable is ignored if still set (the Terraform variable can be dropped with the next
infrastructure change).
