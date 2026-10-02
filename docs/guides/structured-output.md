# Structured output

Give a run an output schema and its answer comes back as an object in that
shape, as `run.output`. The schema can be zod, TypeBox or plain JSON Schema, or a
pydantic model in Python. The agent works as usual (tools, code, files) and then
answers by calling a `final_output` tool whose arguments are your schema. The
system prompt tells it to answer that way. The runtime checks the call against
the schema. If it does not fit, the model gets the call back with what is wrong
and tries again. Once it fits, the run ends.

```ts
import { z } from "zod";

const Triage = z.object({
  category: z.enum(["bug", "billing", "question"]),
  priority: z.number().int().min(1).max(4),
  summary: z.string(),
});

const run = await agent.run("Triage ticket 123", { output: Triage });
run.output; // { category: "bug", priority: 2, summary: "…" }, typed z.infer<typeof Triage>
```

```python
# pip install "camelai-run[pydantic]"
from pydantic import BaseModel
from typing import Literal

class Triage(BaseModel):
    category: Literal["bug", "billing", "question"]
    priority: int
    summary: str

run = await agent.run("Triage ticket 123", output=Triage)
run.output  # Triage(category='bug', priority=2, summary='…')
```

```bash
curl -s https://run.camelai.com/v1/agents/$AGENT/prompt -H "Authorization: Bearer $CAMELAI_API_KEY" \
  -H "Content-Type: application/json" -d '{
    "text": "Triage ticket 123",
    "output": { "schema": { "type": "object",
      "properties": { "category": { "enum": ["bug", "billing", "question"] }, "priority": { "type": "integer" }, "summary": { "type": "string" } },
      "required": ["category", "priority", "summary"] } }
  }'
# Poll GET /v1/agents/$AGENT/requests/<id>: once completed, outcome.result.output is the object.
```

## Schemas

- **The schema must describe an object** (`type: "object"`), at most 64 KB as
  JSON. For a list or a single value, wrap it: `z.object({ items: z.array(…) })`.
- **zod** needs version 4.2 or later. The SDK sends zod's JSON Schema
  (`~standard.jsonSchema`) and then parses the answer with zod, so refinements
  and transforms apply. **TypeBox** (`schema.Object(…)`, exported by the SDK)
  and plain JSON Schema are sent as they are. Any Standard Schema library that
  can produce JSON Schema also works.
- **pydantic** models are sent as `model_json_schema()` (nested models as
  `$defs`) and parsed with `model_validate`, so validators apply.
- The runtime checks what the JSON Schema can express. A check that only zod or
  pydantic can run, such as a refinement or a validator, happens in the SDK. If it
  fails, the run fails with `output_invalid`.

## How the run ends

| Outcome | What you get |
| --- | --- |
| The model called `final_output` with arguments that fit | `status: "completed"`, `output` set, and `text` with anything the model said alongside |
| The model answered in prose | That answer is discarded and the model is asked once more, with a reminder. If it answers in prose again: `status: "failed"`, `error.code: "output_missing"`, and `text` with what it said |
| The answer fit the JSON Schema but failed your zod or pydantic schema | `status: "failed"`, `error.code: "output_invalid"` |
| It waits on a person (an approval, a question) | `input_required`. Answering resumes the run, which still ends with `output` |

Calls whose arguments do not fit are not failures. The model sees them as tool
errors and calls again.

## Notes

- **Per run.** `output` belongs to the prompt that starts a turn. It cannot be
  combined with `whileRunning: "steer"`. Each `run()` with an `output` schema
  declares `final_output` with that schema. The tool stays declared until a run
  without `output`, so a series of runs with the same schema keeps the model's
  tool set unchanged and its prompt cache intact. Switching schemas, or
  switching between structured and plain runs, changes the tool set once.
- **History.** The `final_output` call and its result are ordinary messages in
  the agent's history. Later turns can refer back to the answer.
- **Durable.** A structured run that is resumed on another node still ends with
  `output`.
- **An agent with its own tool named `final_output`** cannot take an output
  schema.
