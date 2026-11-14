### Load chat history while the event stream opens

The browser watcher reads history and state beside the event stream, so chat can load before the first frame. The watcher cuts a stream that delivers no frame for 8 seconds by default (`firstFrameMs`) and switches to long polls after one such SSE stream when fallback is enabled. SSE responses carry `Cache-Control: no-store, no-transform`.
