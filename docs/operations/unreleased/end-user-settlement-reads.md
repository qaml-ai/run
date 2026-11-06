### Model settlement reads an end user's credit room once

Settling a model call billed to an end user reads that user's day of spend and live holds in one query, and reuses that
read and the end user's row lock it already holds, where it took four further round trips before. Charges, allowances,
write-offs and the webhooks they fire are unchanged. A new model attempt's insert also returns its row instead of
reading it back.
