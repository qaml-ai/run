### Compact when a request leaves out older images

A model request that has to leave out older inline images (past the request's image count or byte budget) sends less
than the agent's Pi context holds, so Pi's compaction, which reads the size of the context from that response's usage,
would never see them. Such a request now also starts Pi's compaction in the background, at most once a run and only when
none is running; its summary is placed at the next boundary. Image-heavy agents are compacted sooner, which bounds the
images their context holds in memory. Nothing changes for requests that send everything.
