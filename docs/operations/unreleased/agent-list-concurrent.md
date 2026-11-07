### Workers: listing agents reads their live state 16 at a time, and one unreadable agent no longer fails the list

`GET /v1/agents` read each agent's live state one after another (6 s for a pilot tenant's 48 agents), and a state
fetch that threw under load answered the whole list with a 500. States are now read 16 at a time, and an agent whose
state cannot be read is left out, as one answering with an error always was.
