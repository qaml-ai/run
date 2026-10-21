### Voice sessions need one answer's credit to start

- With end-user credits on, `POST /v1/voice/sessions` with a realtime brain refuses a subject with less than one
  answer's hold left ($0.05) with 402 `END_USER_CREDIT`, where it used to start the session and end it (`budget`) at its
  first answer. A listening session still starts with any credit left. `EndUserCredits.refusal` takes an optional
  `usd`: refused when less than that can be held. See [voice calls](../guides/voice-calls.md).
