### File tools without versions

- The model's file tools (`read`, `write`, `edit`, `ls`, `present_file`, and `fs` in `js_exec`) no longer show file
  versions, and `write` and `edit` no longer take one. The runtime remembers the version of each file the agent last
  read or wrote, and refuses a write or edit of a file that changed since then: "<path> changed since you last read
  it. Read it again". Writing a file only if it does not exist yet (`version: 0`) is gone from the model's tools.
  The files API and the SDKs' volume and file calls keep versions and `If-Match`; `run.files` keeps its versions.
