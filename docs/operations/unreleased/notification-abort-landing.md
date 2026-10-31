### A sub-agent's notification survives an abort as its turn opens

When a parent was aborted just as a sub-agent's notification began its turn, before Pi had the message, the notification
was marked landed but never reached the parent's history, so the parent never learned the sub-agent had finished. It now
lands without a turn, as it already did when an abort reached it earlier.
