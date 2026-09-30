# data-analyst-py

Attach a CSV to a message; the agent analyses it with code in its sandbox (`js_exec` with `fs`), writes a report and
hands it back with `present_file`, which this script saves locally.

```sh
pip install camelai-run   # or: uv run main.py
export CAMELAI_API_KEY=art_...
python main.py
```

```
Comparing revenue in January and June 2026:
- Growing: All North products; South Widget and Gizmo; all West products.
- Shrinking: South Gadget, down 32.1% (from $1,092 to $741).
saved report.md
```

`report.md` has the full table by region and product.
