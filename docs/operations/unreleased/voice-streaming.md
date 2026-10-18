### Voice: no dead air between sentences; a reply's first audio at its first clause

- A session's next speech is made while the one before it plays, once that one is all made. A spoken reply no longer
  waits on a provider round trip between sentences: measured with a 300 ms first byte, the silence between sentences
  went from 322-343 ms to 22-26 ms. A speech made ahead and then stopped ends `interrupted`, billed for what was made.
- A reply's first piece goes as soon as a clause of it is whole (a comma, semicolon, colon or dash, at 24 characters
  or more, with more after it). The pieces after it are whole sentences.
