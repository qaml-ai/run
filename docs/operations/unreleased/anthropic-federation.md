### Platform Anthropic workload identity federation

Operators can use the ECS task role for short-lived Anthropic credentials. Tenant keys keep precedence.
The platform refreshes tokens per node and can fall back to its static Anthropic key during rollout.
See Anthropic via Workload Identity Federation (`docs/operations/anthropic-federation.md`) for setup and verification.
