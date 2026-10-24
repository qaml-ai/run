### Cloudflare reaches the load balancers over HTTP/1.1

Both load balancers have HTTP/2 off. Over HTTP/2, Cloudflare multiplexed many requests on one connection, and an
unread ~1 MB history response (a load cancelled by a quick reload) stalled every other request on it for 25-183 s,
so chat pages hit their 60 s stream timeout. Apply with `infra/apply.sh`; the change is in place, no replacement.
