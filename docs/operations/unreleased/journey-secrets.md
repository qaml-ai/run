### Journey events

- A journey secret that is named (`AGENT_JOURNEY_SECRET_ARN`) and has no value yet no longer stops the runtime from
  starting: journey events and the admin site's reports stay off until it has one, and the log says
  `journey_not_configured`. The Terraform module now makes the two secret containers (`journey`, `journey-report`),
  lets the task role read them and sets the journey settings from `journey_url` and the `journey_*` variables;
  `infra/journey.sh` stores the two values and rolls the service. See
  [Admin analytics](admin-analytics.md#connecting-the-journey-store).
