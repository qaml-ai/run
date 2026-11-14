### Workers job-host plane removed

The Workers backend no longer enrolls, places or dispatches jobs on the legacy host fleet; compute runs on camel-fs VMs (see [the camel-fs compute design](../design/camel-fs-compute.md)). The `delete-job-hosts` migration permanently deletes the `JobHost`, `JobHostRegistry` and `HostJob` Durable Object classes and their stored data wherever it runs.
