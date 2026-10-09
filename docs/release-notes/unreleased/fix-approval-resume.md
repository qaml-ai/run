### Fixes

- An answered input (an approval, an `ask_user` answer, a tool's own question) is no longer lost when the node running
  its resume is lost just as the resume starts. The next owner found the turn still suspended and ended the resume
  `input_required` with no inputs, so an approved call never ran and the agent waited for an answer no one could give.
  The resume now runs again from its answers there: an approved call runs once. A call the agent had already released
  to run still ends as of unknown outcome and is never run again.
