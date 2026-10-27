### Large history reads in Python and journal backlogs

The Python SDK's `history()` now collects bounded pages, like the TypeScript SDK,
so histories larger than 64 MiB remain readable. Its return shape is unchanged.
History pages that need messages before the journal's base read only the missing
range from the index. The 64 MiB read limit applies to the chunks in that range.
