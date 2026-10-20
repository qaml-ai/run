### Live Pi compaction limits

Pi sessions now apply changes to `runLimits.contextTokens` on the next request,
including recalculating how much context to reserve and retain. Host checkpoints
preserve message boundaries so Pi can compact across separate user turns as well
as long tool loops. Full history remains available.
