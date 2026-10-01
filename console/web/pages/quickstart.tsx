import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock, PageHeader } from "@/components/common";
import { useApi, type Model } from "@/lib/api";
import { Link } from "@/lib/router";

export function QuickstartPage() {
  const available = useApi<Model[]>("/v1/models?available=true");
  const url = location.origin;
  // The examples name no model, so agents get the account's default; this one only shows how to choose.
  const model = available.data?.[0]?.id ?? "<model id>";
  // The hosted runtime is the SDKs' default; another origin (a self-hosted console) is named explicitly.
  const hosted = url === "https://run.camelai.com" || url === "https://agents.camelai.dev";
  const prompt = `Read ${url}/SKILL.md and set up camelRun in this project.`;
  const mcp = `# Claude Code (then /mcp to sign in)
claude mcp add --transport http camelrun ${url}/mcp

# Codex
codex mcp add camelrun --url ${url}/mcp && codex mcp login camelrun`;
  const typescript = `import { Agents, schema, tool } from "@camelai/run";

const agents = new Agents(${hosted ? "" : `{ url: "${url}" }`}); // reads CAMELAI_API_KEY: an API token from this console

// A tool is an ordinary function: it runs in your process, with your credentials.
const weather = tool({
  description: "Today's weather in a city",
  input: schema.Object({ city: schema.String() }),
  execute: ({ city }) => ({ city, forecast: "sunny", highC: 24 }),
});

// The same key is the same agent, with its history, every time.
const agent = await agents.upsert("quickstart", {
  instructions: "You are a concise assistant.",
  tools: { weather },
});

const run = await agent.run("Should I bring an umbrella in Lisbon today?");
console.log(run.text);

await agents.close();`;
  const python = `import asyncio
from camelai_run import Agents, tool

@tool
def weather(city: str) -> dict:
    """Today's weather in a city"""
    return {"city": city, "forecast": "sunny", "highC": 24}

async def main():
    async with Agents(${hosted ? "" : `url="${url}"`}) as agents:  # reads CAMELAI_API_KEY
        agent = await agents.upsert("quickstart", instructions="You are a concise assistant.", tools=[weather])
        run = await agent.run("Should I bring an umbrella in Lisbon today?")
        print(run.text)

asyncio.run(main())`;
  const rest = `export CAMELAI_API_KEY=art_...   # from API tokens
BASE=${url}; AUTH="Authorization: Bearer $CAMELAI_API_KEY"

# Upsert an agent: the Idempotency-Key is its key, so the same key is the same agent.
# (Tools that run in your code need an SDK or a tool server of yours; this agent has built-in tools only.)
AGENT=$(curl -s $BASE/v1/agents -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: quickstart" \\
  -d '{"systemPrompt": "You are a concise assistant."}' | jq -r .id)

# Send a message, wait for the run, print its reply
REQ=$(curl -s $BASE/v1/agents/$AGENT/prompt -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"text": "Write a haiku about durable agents."}' | jq -r .id)
until curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -e '.state == "completed"' > /dev/null; do sleep 1; done
curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -r '.outcome.result.reply // .outcome.error'`;
  const choose = `const agent = await agents.upsert("quickstart", { model: "${model}", instructions: "…" });`;
  const stream = `for await (const part of agent.stream("And tomorrow?")) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(\`\\n[\${part.name}]\`);
}`;
  return (
    <>
      <PageHeader title="Quickstart" description={<>Run your first agent: from your coding agent, or from your application with an <Link className="underline" to="tokens">API token</Link>.{hosted && <> GitHub accounts older than 30 days start with free credit; everyone else gets it by verifying a card under <Link className="underline" to="billing">Billing</Link> (no charge).</>}</>} />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Set up with your coding agent</CardTitle>
            <CardDescription>Paste this into Claude Code, Codex, Cursor or any coding agent. It installs the SDK, has you add an API token to <code>.env.local</code> (never into the chat), and runs your first agent.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <CodeBlock language="prompt" code={prompt} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Or try it with no API key</CardTitle>
            <CardDescription>Connect your coding agent to the hosted MCP server and sign in, then ask it to build you an agent.</CardDescription>
          </CardHeader>
          <CardContent><CodeBlock language="shell" code={mcp} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>1. Install the SDK</CardTitle>
            <CardDescription>
              TypeScript needs Node 22+ (or Bun); Python 3.11+. Export an <Link className="underline" to="tokens">API token</Link> as <code>CAMELAI_API_KEY</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <CodeBlock language="shell" code="npm install @camelai/run" />
            <CodeBlock language="shell" code="pip install camelai-run" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>2. Run an agent with your tools</CardTitle>
            <CardDescription>Your tools are ordinary functions in your process. The runtime runs the model loop, keeps the agent's history, and sandboxes model-written code that calls your tools. The script prints the reply and exits; run it again and the agent remembers.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="typescript">
              <TabsList><TabsTrigger value="typescript">TypeScript</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger><TabsTrigger value="rest">curl</TabsTrigger></TabsList>
              <TabsContent value="typescript" className="pt-3"><CodeBlock language="ts" code={typescript} /></TabsContent>
              <TabsContent value="python" className="pt-3"><CodeBlock language="python" code={python} /></TabsContent>
              <TabsContent value="rest" className="pt-3"><CodeBlock language="shell" code={rest} /></TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Optional: choose a model</CardTitle>
            <CardDescription>An agent that names no model gets your account's default. To choose another, list the models your account can use (also under <Link className="underline" to="models">Models &amp; keys</Link>), and pass one as <code>model</code>.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <CodeBlock language="shell" code="npx -y @camelai/camelrun models --available" />
            <CodeBlock language="ts" code={choose} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>3. Stream it</CardTitle>
            <CardDescription>Show the run as it happens: its text as the model writes it, each tool call, then the run. The run's result is the truth; the stream is for display.</CardDescription>
          </CardHeader>
          <CardContent><CodeBlock language="ts" code={stream} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Next</CardTitle>
            <CardDescription>
              Change models any time with <code>agent.configure({"{"} model {"}"})</code>: the history carries over. For approvals, browsers, files and serving tools to many users, see the docs, also as Markdown for your coding agent at <a className="underline" href="/llms.txt">/llms.txt</a>.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </>
  );
}
