import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock, PageHeader } from "@/components/common";
import { useApi, type Model } from "@/lib/api";
import { Link } from "@/lib/router";

export function QuickstartPage() {
  const available = useApi<Model[]>("/v1/models?available=true");
  const url = location.origin;
  const model = available.data?.find(entry => entry.id === "anthropic/claude-sonnet-5")?.id ?? available.data?.[0]?.id ?? "anthropic/claude-sonnet-5";
  // The hosted runtime is the SDKs' default; another origin (a self-hosted console) is named explicitly.
  const hosted = url === "https://run.camelai.com" || url === "https://agents.camelai.dev";
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
  model: "${model}",
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
        agent = await agents.upsert("quickstart", model="${model}",
                                    instructions="You are a concise assistant.", tools=[weather])
        run = await agent.run("Should I bring an umbrella in Lisbon today?")
        print(run.text)

asyncio.run(main())`;
  const rest = `export CAMELAI_API_KEY=art_...   # from API tokens
BASE=${url}; AUTH="Authorization: Bearer $CAMELAI_API_KEY"

# Models you can use now
curl -s "$BASE/v1/models?available=true" -H "$AUTH"

# Upsert an agent: the Idempotency-Key is its key, so the same key is the same agent.
# (Tools that run in your code need an SDK or a tool server of yours; this agent has built-in tools only.)
AGENT=$(curl -s $BASE/v1/agents -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: quickstart" \\
  -d '{"model": "${model}", "systemPrompt": "You are a concise assistant."}' | jq -r .id)

# Send a message, wait for the run, print its reply
REQ=$(curl -s $BASE/v1/agents/$AGENT/prompt -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"text": "Write a haiku about durable agents."}' | jq -r .id)
until curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -e '.state == "completed"' > /dev/null; do sleep 1; done
curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -r '.outcome.result.reply // .outcome.error'`;
  const stream = `for await (const part of agent.stream("And tomorrow?")) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(\`\\n[\${part.name}]\`);
}`;
  return (
    <>
      <PageHeader title="Quickstart" description={<>Create an agent from your application. First add a model key under <Link className="underline" to="models">Models &amp; keys</Link> and create an <Link className="underline" to="tokens">API token</Link>.</>} />
      <div className="flex flex-col gap-4">
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
