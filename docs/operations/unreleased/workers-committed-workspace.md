### Workers workspace files use committed versions

File tools and the HTTP file API read the latest committed version. While a Bash machine holds the branch's write lease, file writes outside Bash return `409` until the lease is released. Bash saves workspace changes to the branch before returning success.
