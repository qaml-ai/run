CREATE TABLE vault_secrets (
  tenant text NOT NULL,
  workspace text NOT NULL DEFAULT '',
  name text NOT NULL,
  policy jsonb NOT NULL,
  sealed jsonb NOT NULL,
  PRIMARY KEY (tenant, workspace, name)
);
