### Computer files share the file tools

A running shell computer mounts its home directory at `/computer`. `read`,
`write`, `edit`, `ls`, `glob` and `grep` use it as they use
volumes. Computer files disappear when the session expires or stops.

New `cp` and `mv` tools copy or move files between mounts, without sending their
contents through the model. Directory copies need `recursive: true`; replacing
a destination needs `overwrite: true`. Each call handles at most 1,000 files.
Same-volume moves commit together; cross-mount moves remove each source after
its copy verifies. A failure can leave a directory partly moved.

`computer_upload` and `computer_download` are removed from model-facing tool
lists. Replace them with `cp` or `mv` using `/computer` paths. See
`docs/guides/files.md` and `docs/guides/computers.md`.
