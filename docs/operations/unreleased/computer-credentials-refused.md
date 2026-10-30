### A refused computer key no longer blocks the computer

A provider answering 401 or 403 when a computer starts has made nothing, so the session now closes instead of staying
`uncertain` until someone confirms cleanup. `computer_start` says the credentials were refused; disconnect and reconnect
with a working key. Any other failed start stays `uncertain`, because a lost response may have made a machine. Agents'
computer tools also say when to stop a computer, that `computer_start` comes first, and who can clear a failed start.
