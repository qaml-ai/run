### Workers: the `POST /v1/agents/{id}/children` prototype is gone

The Workers backend still answered an early prototype, `POST /v1/agents/{id}/children` with `{task, key, agent}`: it
made a "Child of …" agent without the sub-agent type and prompted it unsigned, so since sub-agents are reached only
through their parent it made an agent outside that rule. Nothing documented or used it, and Node never had it. It now
answers 404 like any unknown route. `GET /v1/agents/{id}/children` (the list of an agent's delegate and spawn_agent
children) is unchanged; sub-agents are made by the delegate and spawn_agent builtins.
