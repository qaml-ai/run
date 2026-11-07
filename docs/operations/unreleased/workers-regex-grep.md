### Workers: `grep` with `regex: true` searches instead of answering FILE_501

Regex grep on Workers answered `FILE_501: Regular-expression grep requires isolated execution`, since a Durable Object
cannot stop a JavaScript RegExp that backtracks catastrophically. It now matches with RE2 (`re2js`), whose time is linear
in the text, so a pattern like `(a+)+$` costs no more than a plain search. Results have the same shape as plain grep. RE2
has no lookarounds or backreferences; such a pattern, like any that does not compile, is refused as `Invalid regular
expression: ...`, the words Node uses. A search now also stops after reading 32 MiB, Node's budget, and answers what it
found with `truncated: true`.
