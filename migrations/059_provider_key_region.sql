-- The AWS region an account's own amazon-bedrock key calls (PUT /v1/providers/amazon-bedrock/key); null for every
-- other provider. A Bedrock API key is not bound to a region, so the region is kept beside it, in the clear.
alter table provider_keys add column region text;
