### Bound reads for v2 history pages

The history endpoint uses the requested cursor and page size to read conversation entries and their metadata from SQLite. Small pages in long conversations no longer load the entire transcript into the agent's memory.
