-- Provider feedback looks up only recorded deliveries; IDs contain no credentials.
CREATE INDEX billing_email_outbox_provider_id ON billing_email_outbox (provider_message_id)
WHERE provider_message_id IS NOT NULL;
