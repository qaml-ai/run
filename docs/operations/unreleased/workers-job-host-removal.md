# Workers job-host plane removed

The Workers backend no longer enrolls, places or dispatches jobs on the legacy host fleet. See the camel-fs compute design in `docs/design/camel-fs-compute.md`. The `delete-job-hosts` migration permanently deletes the three job-host Durable Object classes and their stored data wherever it runs.
