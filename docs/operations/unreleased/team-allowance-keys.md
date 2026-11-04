### Shared accounts can retain per-bot allowance rules

Allowance and bucket-limit maps no longer stop at 100 keys. A team with more than
50 moved bots needs two exact allowance rules per bot to preserve each bot's daily
free pool across payer changes. Key syntax, amounts, request-body limits and
tenant authorization are unchanged. Concurrent map updates still merge under
the existing row locks.
