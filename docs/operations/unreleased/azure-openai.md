### Platform images and transcription on Azure OpenAI

- An operator can send images and transcription made on the platform's OpenAI key to its own Azure OpenAI deployments
  (`AGENT_AZURE_OPENAI_ENDPOINT` and `AGENT_AZURE_OPENAI_API_KEY`, or `AGENT_AZURE_OPENAI_SECRET_ARN`; deployments
  default to `gpt-image-2.5-flare` and `gpt-transcribe`). A tenant's own key, an operator-set one and a key scope's stay
  on OpenAI. When Azure is rate limited, down or has no such deployment, the platform's OpenAI key makes it instead.
  Billing is unchanged. Azure's content filter refusals are `IMAGE_REFUSED`, as OpenAI's are. See
  [Configuration](configuration.md).
- Hosted: Terraform adds the `azure-openai` secret, its ECS environment variable and the task role's read of it;
  `infra/azure-openai.sh` stores the resource's endpoint and key and rolls the service.
