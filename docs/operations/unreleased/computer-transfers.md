### Computer file transfers

Shell computers now offer `computer_upload` and `computer_download` to copy binary
files between their remote filesystem and the agent's workspace. Results contain
only the path, byte size and SHA-256 digest. Files can be up to 256 MiB, subject to
workspace permissions and storage quotas. Each transfer uses a single-use URL
that expires within five minutes. See `docs/guides/computers.md`.
