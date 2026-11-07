### Builtins repair more argument shapes models send

As with `edit` (#721) and long `ask_user` headers (#720), these are now repaired rather than refused, on Node and Workers
alike (found running camelCode on DeepSeek V4.1 Flash): an `ask_user` question without a header gets its first words; a
question without options is answered in the person's own words (`allowOther`); and a `delegate`/`spawn_agent` `output`
schema sent as a JSON string, wrapped in `{ schema }`, or with `properties` but no `type` is read as the object schema it
describes. A single option is still refused. See `docs/reference/limits.md`.
