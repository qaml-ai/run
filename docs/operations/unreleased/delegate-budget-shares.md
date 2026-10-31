### Delegates in one response always share the run's budget

With a run's spend limit, each delegate call in a response gets an even share of what the run has left. The share counted
only calls already at the node, so one that arrived late, or waited for a `maxParallel` slot, could find the first child
holding the whole budget and fail with "This run has no budget left for a sub-agent". Shares now count every delegate call
in the response. Sequential children no longer get everything left to whichever ran first.
