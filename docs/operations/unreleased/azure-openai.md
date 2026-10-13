### Platform images, transcription and chat models on Azure OpenAI

- An operator can send images and transcription made on the platform's OpenAI key to its own Azure OpenAI deployments
  (`AGENT_AZURE_OPENAI_ENDPOINT` and `AGENT_AZURE_OPENAI_API_KEY`, or `AGENT_AZURE_OPENAI_SECRET_ARN`; deployments
  default to `gpt-image-2.5-flare` and `gpt-transcribe`). A tenant's own key, an operator-set one and a key scope's stay
  on OpenAI. When Azure is rate limited, down or has no such deployment, the platform's OpenAI key makes it instead.
  Billing is unchanged. Azure's content filter refusals are `IMAGE_REFUSED`, as OpenAI's are. See
  [Configuration](configuration.md).
- Hosted: Terraform adds the `azure-openai` secret, its ECS environment variable and the task role's read of it;
  `infra/azure-openai.sh` stores the resource's endpoint and key and rolls the service.
- The same resource can serve the catalog's `azure/<model>` chat models (`azure/gpt-6-sol`, `azure/gpt-6-luna`, …) as
  platform models: `AGENT_AZURE_OPENAI_MODELS` (or `models` in the secret) names each model's deployment. Tenants on the
  platform's keys see those as available in `GET /v1/models` and are billed at OpenAI's price for the same model
  (Azure's Global Standard price); an undeployed one is refused with a clear error. `azure` models are now priced as
  OpenAI's of the same id, long-context tier included (Pi's entries lacked it). `scripts/azure-models-check.ts` checks
  the deployments with one minimal call each. `infra/azure-openai.sh` takes the models as a fourth argument.
