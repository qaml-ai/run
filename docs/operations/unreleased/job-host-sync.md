### Workers: a job on our own hosts can take a tree past 16 MiB (host-side sync)

A job's files used to cross to its host inline, through the runtime's RPC, up to 16 MiB; a larger volume tree failed
`sync_failed`. Now a larger tree (up to the job sync limits: 100,000 files, 64 MiB a file, 4 GiB in all) is fetched by
the host itself:
- **What the host gets:** the job carries a manifest (each file's path, size and sha256) and a token for this job's
  files only, valid for the job's lifetime and kept hashed by its job object.
- **How it fetches:** the host fetches each file with `GET /v1/internal/job-hosts/sync/<job>/<index>`, which streams
  it from storage. It checks each file's size and sha256 as it streams, and writes it into the VM in 4 MiB pieces.
- **The token:** it never reaches the VM. It serves nothing once the job has ended.
- **Small trees:** a tree up to 16 MiB still crosses inline.
