### A wait_agent takes the ending it answers, even with `delegate.notify: "asap"`

With `delegate.notify: "asap"`, a sub-agent's ending that arrives while a `wait_agent` is in flight goes into the
wait's result. The wait stopped counting as in flight once its loop ended, a moment before it took the endings, so an
ending arriving in that moment could be steered into the running turn as a notification instead, and the wait
answered "Its answer comes (or came) as a notification". The wait now stays in flight until it has taken them, on both
backends.
