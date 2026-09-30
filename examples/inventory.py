"""A Python/SQLite application exposing ordinary functions to a hosted agent.
By default it runs scripted code with the tools (no model); --prompt "..." asks the model instead.

    CAMELAI_API_KEY=art_... python examples/inventory.py --prompt "Plan restocks for everything below target."
"""
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))
from camelai_run import Agents, ToolContext, tool


async def main():
    # Synthetic, process-local database: no production systems or credentials.
    # A plain-function tool runs in a thread, so the connection is shared across threads (SQLite serializes it).
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE inventory (sku TEXT PRIMARY KEY, item TEXT, stock INTEGER, target INTEGER);
        INSERT INTO inventory VALUES ('BEAN-01', 'Espresso beans', 8, 40), ('OAT-02', 'Oat milk', 6, 30), ('CUP-03', 'Cups', 200, 100);
        CREATE TABLE restock (sku TEXT PRIMARY KEY REFERENCES inventory(sku), quantity INTEGER, call_id TEXT);
    """)

    @tool
    async def read_inventory():
        """Read inventory and target stock from the application's SQLite database."""
        return [dict(row) for row in db.execute("SELECT * FROM inventory ORDER BY sku")]

    @tool
    def plan_restock(sku: str, quantity: int, context: ToolContext):
        """Set one SKU's local restock quantity. Does not place orders."""
        if type(quantity) is not int or not 1 <= quantity <= 100:
            raise ValueError("Invalid restock quantity")
        if not db.execute("SELECT 1 FROM inventory WHERE sku = ?", (sku,)).fetchone():
            raise ValueError("Unknown SKU")
        # The call's stable key: a retried call rewrites the same row.
        db.execute("INSERT OR REPLACE INTO restock VALUES (?, ?, ?)", (sku, quantity, context.idempotency_key))
        db.commit()
        return {"planned": True, "sku": sku, "quantity": quantity}

    async with Agents() as agents:
        agent = await agents.upsert("inventory", instructions="You manage cafe stock. Plan restocks without purchasing anything.",
                                    tools=[read_inventory, plan_restock], **({"model": os.environ["AGENT_MODEL"]} if os.environ.get("AGENT_MODEL") else {}))
        try:
            print(f"\nPython + SQLite inventory → hosted agent {agent.id}")
            if "--prompt" in sys.argv:
                index = sys.argv.index("--prompt")
                prompt = sys.argv[index + 1] if len(sys.argv) > index + 1 else "Read the cafe inventory. Plan restocks for every item below target and explain the plan."
                run = await agent.run(prompt)
                print(run.text)
            else:
                # Code the model could have written, run in the agent's sandbox with its tools (no model call).
                result = await agent.client.execute("""
                    const rows = await tools.read_inventory({});
                    const low = rows.filter(row => row.stock < row.target);
                    return await Promise.all(low.map(row => tools.plan_restock({sku: row.sku, quantity: row.target - row.stock})));
                """)
                print(json.dumps({"agentResult": result}, indent=2))
            print(json.dumps({"localRestockPlan": [dict(row) for row in db.execute("SELECT sku, quantity FROM restock ORDER BY sku")]}, indent=2))
        finally:
            db.close()


if __name__ == "__main__":
    asyncio.run(main())
