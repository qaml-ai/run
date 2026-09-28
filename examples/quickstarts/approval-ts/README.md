# approval-ts

Human in the loop: `delete_file` has `needsApproval: true`, so the run stops before each call and the CLI asks you.
The run waits for as long as it takes (nothing is billed while it waits), then resumes with your answer.

```sh
npm install
export CAMELAI_API_KEY=art_...
npm start
```

```
Allow delete_file to run? {"name":"cache.tmp"} [y/N] y
Allow delete_file to run? {"name":"old-draft.tmp"} [y/N] n
Deleted `cache.tmp`. I couldn't delete `old-draft.tmp` because that deletion was declined.
left: [ 'build.log', 'notes.md', 'old-draft.tmp' ]
```

It works in the throwaway `playground/` folder it creates.
