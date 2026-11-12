For many units of work, write a workflow like this one, with one agent() per unit:

```js
const results = await parallel(args.files.map(file => () =>
  agent(`Migrate /repo/${file} as described in /repo/MIGRATION.md. Edit only that file.`, { key: `migrate:${file}`, type: "worker", repo: args.volume })));
for (const result of results.filter(Boolean)) await commit(result.fork);
```
