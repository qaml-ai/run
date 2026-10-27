### Pi's own storage failure rule

The agent no longer wraps its Pi storage in a proxy that re-implemented Pi's rule for which storage failures fail the
Session. Pi 1.4 guards its own storage calls and reports `session_failed`; the agent ends its run with
`PERSISTENCE_FAILED` and is given up on that report, as before. A storage that fails to close also counts now, as Pi
treats it.
