### Answer inbox items in a batch

The inbox accepts up to 100 answers in one `POST /v1/inbox/answers` request. Send
a `requestId` and each item's inbox `id` and observed `version`. Each item gets
its own result; stale versions and settled items do not block other answers.
Reusing a completed request's key returns its recorded outcomes. The TypeScript
and Python SDKs expose `answerInbox` and `answer_inbox`; the CLI exposes
`inbox-answer`.
