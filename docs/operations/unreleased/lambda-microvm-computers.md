### Lambda MicroVMs for managed computers

Managed computers default to AWS Lambda MicroVMs. ARM64 sessions suspend when idle,
resume on traffic and last up to 8 hours, including suspension. Long commands use
idempotent jobs and short result polls. The guest receives no AWS execution role.

Set `AGENT_COMPUTER_PROVIDER=boat` to use Boat for new sessions. Existing sessions
retain their provider. Lambda usage is estimated from persisted state observations,
with running time and snapshot activity charged through the existing credit meter.
Operators must build an image and apply IAM before enabling the provider; see
`docs/operations/microvm-computers.md`.
