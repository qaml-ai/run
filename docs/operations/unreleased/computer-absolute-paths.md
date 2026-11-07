### Workers: the `computer` tool takes absolute `/workspace/...` paths for read, write and parse

Models name files where `exec` runs them, `/workspace/<repo>/src/app.js`, and every such call was refused as "Expected a
relative workspace file path without dot segments". A path under `/workspace` is now made relative; any other absolute or
`..` path (`/tmp/pr.json`) is refused saying that paths are in `/workspace` and that `exec` reaches other places.
