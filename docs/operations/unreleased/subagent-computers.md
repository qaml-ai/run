### Sub-agents get their own computers

New sub-agents inherit a separate computer connection from their parent, with
the same provider, credentials, managed setting and time limits. The child starts
its own session with `computer_start`. Set `subagents: false` when attaching a
computer to opt out; the setting carries to grandchildren. Existing named
agents keep their own connections. Each connection is billed as usual.

Deleting or expiring a child stops its computer through the normal detach path.
The parent has no mount of child computers. Inline children share the parent's
volume mounts; definition children use the definition's mounts. Copy results to
a shared volume to exchange files. Parent mounts of child computers may follow.
