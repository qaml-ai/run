### Answer inbox items in a batch

The inbox accepts up to 100 answers in one `POST /v1/inbox/answers` request. Send
a `requestId` and each item's inbox `id` and observed `version`. Each item gets
its own result; stale versions and settled items do not block other answers.
Reusing a completed request's key returns its recorded outcomes for seven days;
a different payload with that key is refused. An unavailable agent returns
retryable item outcomes without blocking the other agents. The TypeScript
and Python SDKs expose `answerInbox` and `answer_inbox`; the CLI exposes
`inbox-answer`.

The console Inbox uses the batch endpoint and reports each item's conflict or
availability error. Answers identify the public input by `agent` and `id`, plus
its observed `version`. A request may mix blocking inputs and decisions; each
kind settles independently, and one agent's decision answers share one notice.
