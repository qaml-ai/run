### Decisions with one side of a noul's criteria work

OpenRouter refuses a noul question whose `criteria` has only `true` or only `false` (HTTP 400, `invalid_union`), which the
API and SDKs allow. Such a question failed its whole decision. camelRun now sends the other side: yes is the question's
statement, no is "Anything else.". Each failed decision also logs `decision_failed` with its status and code.
