### Pi without TypeBox

Pi moves to main `c9f4c7b9fcd0`. It now checks tool arguments with its own `pi-schema` package instead of TypeBox, so
the message an agent sees for invalid tool arguments is worded differently. Tool search also handles Unicode words and
ranks like the coding agent's.
