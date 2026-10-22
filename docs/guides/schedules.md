# Scheduled agents and email reports

Open an agent in the console and select **Schedules**. Enter its task, choose
Daily or Weekdays, set the local time and IANA time zone, and optionally add an
email recipient and subject. The agent needs no application process to stay
connected when it uses built-in tools. Its instructions and saved files are
available at every wake-up; each run is recorded in its history.

For example, `POST /v1/agents/{id}/schedules`:

```json
{
  "text": "Research today's developments, save the report, and return the complete report with source links.",
  "history": "none",
  "calendar": {
    "time": "08:00",
    "timeZone": "America/Chicago",
    "daysOfWeek": [1, 2, 3, 4, 5]
  },
  "email": { "to": "reader@example.com", "subject": "Daily research" }
}
```

Omit `daysOfWeek` to run daily. Sunday is 0 and Saturday is 6. Calendar schedules
keep their local time through daylight saving changes. Each calendar wake-up includes
its scheduled UTC time and local edition date, so report dates do not depend on
what the model infers from search results. A missing local time is
skipped; a repeated local time runs once. Missed occurrences are skipped after
recovery. Calendar cannot be combined with `at`, `inSeconds`, or `everySeconds`;
those existing one-off and interval options continue to work.

Email delivery sends the successful run's complete final reply as formatted Markdown HTML,
with a plain-text alternative. Headings, lists, tables and source links are preserved;
raw HTML is escaped and images remain links. Have the agent
include its report in that reply, not just a saved-file path. Failed or empty
runs are not emailed. Delivery state is visible in the Schedules tab and at
`GET /v1/agents/{id}/schedule-deliveries`. Delivery waits durably for the run to
finish and retries transient mail errors. SES delivery is at least once: a lost
send acknowledgement can cause a duplicate. The email recipient is configured
by the owner through the API or console, not by the agent's scheduling tool.
Use your sign-in email or a verified recipient from Billing → email alerts.
Operator-configured tenants can use other recipients. Suppressed addresses are
refused, and recipient eligibility is checked again before each delivery.

On self-hosted runtimes, scheduled email uses the SES account-mail configuration
(`AGENT_ACCOUNT_EMAIL_FROM`, with provider `ses`, and its region and configuration
set). Without it, schedules with email are refused. Existing schedules without
email are unaffected. TypeScript accepts `calendar` and `email` in `schedule()`;
Python accepts the same dictionaries. The MCP `add_schedule` tool accepts both fields. The schedule builtin also accepts
`calendar` for the agent's own wake-ups.
