import { useState, type FormEvent, type ReactNode } from "react";
import { Check, KeyRound, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock, CopyButton, ErrorAlert, LearnMore } from "@/components/common";
import { api, type AgentDetail, type AgentSummary, type Billing, type RequestRecord } from "@/lib/api";
import { PLAYGROUND_KEY, type Step, type useOnboarding } from "@/lib/onboarding";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** A checklist that ticks itself off from the account's state; the done mark is the signal-blue success check. */
export function Checklist({ steps, label }: { steps: Step[]; label: string }) {
  const done = steps.filter(step => step.done).length;
  return (
    <div className="bg-card border p-4" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className="text-muted-foreground font-mono text-xs">{done}/{steps.length}</span>
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.id} data-done={step.done || undefined} className={cn("flex items-center gap-2 text-sm", step.done ? "text-foreground" : "text-muted-foreground")}>
            <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center border font-mono text-[10px]", step.done && "border-[var(--chart-1)] text-[var(--chart-1)]")}>
              {step.done ? <Check className="size-3" /> : index + 1}
            </span>
            {step.label}<span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A numbered step of a path: its title, what it is for, and its content. */
export function StepCard({ n, title, description, done, children }: { n: number; title: string; description?: ReactNode; done?: boolean; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className={cn("flex size-5 items-center justify-center border font-mono text-[10px]", done && "border-[var(--chart-1)] text-[var(--chart-1)]")}>{done ? <Check className="size-3" aria-label="done" /> : n}</span>
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="flex flex-col gap-3">{children}</CardContent>}
    </Card>
  );
}

/** The install and first-agent code, at this console's origin, with `key` filled in when there is one to show. */
export function snippets(url: string, key?: string) {
  // The hosted runtime is the SDKs' default; another origin (a self-hosted console) is named explicitly.
  const hosted = url === "https://run.camelai.com" || url === "https://agents.camelai.dev";
  const env = `export CAMELAI_API_KEY=${key ?? "art_...   # create a key in step 2"}`;
  return {
    hosted,
    prompt: `Read ${url}/SKILL.md and set up camelRun in this project, then build an agent that <what it should do>.`,
    mcp: `# Claude Code (then /mcp to sign in)
claude mcp add --transport http camelrun ${url}/mcp

# Codex
codex mcp add camelrun --url ${url}/mcp && codex mcp login camelrun`,
    install: {
      typescript: `npm install @camelai/run && npm pkg set type=module\n${env}`,
      python: `pip install camelai-run\n${env}`,
      rest: env,
    },
    typescript: `// agent.js: run it with node agent.js
import { Agents, schema, tool } from "@camelai/run";

const agents = new Agents(${hosted ? "" : `{ url: "${url}" }`}); // reads CAMELAI_API_KEY

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

await agents.close();`,
    python: `# agent.py: run it with python agent.py
import asyncio
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

asyncio.run(main())`,
    rest: `BASE=${url}; AUTH="Authorization: Bearer $CAMELAI_API_KEY"

# Upsert an agent: the Idempotency-Key is its key, so the same key is the same agent.
# (Tools that run in your code need an SDK or a tool server of yours; this agent has built-in tools only.)
AGENT=$(curl -s $BASE/v1/agents -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: quickstart" \\
  -d '{"systemPrompt": "You are a concise assistant."}' | jq -r .id)

# Send a message, wait for the run, print its reply
REQ=$(curl -s $BASE/v1/agents/$AGENT/prompt -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"text": "Write a haiku about durable agents."}' | jq -r .id)
until curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -e '.state == "completed"' > /dev/null; do sleep 1; done
curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -r '.outcome.result.reply // .outcome.error'`,
  };
}

/** Needs no tools, so nothing it does leaves the runtime. */
export const PLAYGROUND_PROMPT = "In three short sentences, explain what a durable agent is. Then write a haiku about one.";

/**
 * The no-code path: one agent per account (key `playground`) on the account's default model, with no tools, and one run
 * at a time: a run still going is shown instead of starting another. Spend limits and run caps apply as to any agent.
 */
export function Playground({ agents, onRan }: { agents?: AgentSummary[]; onRan: () => void }) {
  const [draft, setDraft] = useState(PLAYGROUND_PROMPT);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [error, setError] = useState<string>();
  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined); setReply(undefined);
    try {
      const id = agents?.find(agent => agent.key === PLAYGROUND_KEY)?.id ?? (await api<{ id: string }>("/v1/agents", {
        body: { name: "Playground", systemPrompt: "You are a friendly, concise assistant answering in the camelRun console's playground.", builtins: [] },
        headers: { "Idempotency-Key": PLAYGROUND_KEY },
      })).id;
      setAgentId(id);
      const running = (await api<AgentDetail>(`/v1/agents/${id}`)).requests?.find(request => request.state === "running");
      let request = running ?? await api<RequestRecord>(`/v1/agents/${id}/prompt`, { body: { text: draft.trim(), requestId: crypto.randomUUID() } });
      onRan();
      while (request.state === "running") {
        await new Promise(resolve => setTimeout(resolve, 1000));
        request = await api<RequestRecord>(`/v1/agents/${id}/requests/${request.id}`);
      }
      // The runtime's own failure is outcome.error; the model's (a refusal, a missing key, a spend or turn limit) is the result's.
      const result = request.outcome?.result as { reply?: string; error?: string | null } | undefined;
      const failed = request.outcome?.error ?? result?.error;
      if (failed) setError(failed);
      if (!failed || result?.reply) setReply(result?.reply ?? "");
      onRan();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={run} className="flex flex-col gap-3">
      <Label htmlFor="playground-prompt" className="sr-only">Prompt</Label>
      <Textarea id="playground-prompt" rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !draft.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Play />}{busy ? "Running…" : "Run"}</Button>
        {agentId && <Link className="text-sm underline underline-offset-4" to={`agents/${agentId}`}>Open the agent</Link>}
      </div>
      <ErrorAlert error={error} title="The run failed" className="mb-0" />
      {reply !== undefined && (
        <div className="bg-muted border p-3" aria-live="polite">
          <Eyebrow>REPLY</Eyebrow>
          <p className="mt-2 text-sm whitespace-pre-wrap">{reply || "(no text)"}</p>
        </div>
      )}
    </form>
  );
}

/** Creating a key in place: shown once, then filled into the code below for as long as the page is open (never stored). */
function CreateKey({ count, created, onCreated }: { count: number; created?: string; onCreated: (token: string) => void }) {
  const [name, setName] = useState("Quickstart");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try { onCreated((await api<{ token: string }>("/v1/tokens", { body: { name: name.trim() } })).token); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  if (created) return (
    <div className="bg-card border-foreground/40 border p-3">
      <div className="flex items-center justify-between gap-2"><Eyebrow>SHOWN ONCE</Eyebrow><CopyButton value={created} label="Copy key" /></div>
      <code className="mt-1 block font-mono text-xs leading-relaxed break-all">{created}</code>
      <p className="text-muted-foreground mt-2 text-xs">It's filled into the code below until you leave this page. Keep it on your backend: never ship it to a browser or app.</p>
    </div>
  );
  return (
    <form onSubmit={create} className="flex flex-col gap-2">
      <ErrorAlert error={error} className="mb-0" />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5"><Label htmlFor="start-key-name">Key name</Label><Input id="start-key-name" className="w-56" value={name} onChange={event => setName(event.target.value)} /></div>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Create API key</Button>
      </div>
      {count > 0 && <p className="text-muted-foreground text-xs">You have {count} key{count === 1 ? "" : "s"} already (<Link className="underline underline-offset-4" to="tokens">API keys</Link>). A key is shown only when it's made, so make one here to have it filled in below.</p>}
    </form>
  );
}

export function CodePath({ onboarding, billing }: { onboarding: ReturnType<typeof useOnboarding>; billing?: Billing }) {
  const [key, setKey] = useState<string>();
  const url = location.origin;
  const code = snippets(url, key);
  const [tryStep, keyStep, codeStep] = onboarding.code;
  const reload = () => { void onboarding.agents.reload(); void onboarding.usage.reload(); };
  return (
    <div className="flex flex-col gap-4">
      <Checklist label="YOUR FIRST AGENT" steps={onboarding.code} />
      <StepCard n={1} title="Try an agent right here" done={tryStep.done}
        description={<>No code: this makes an agent called Playground on your account's default model and runs your prompt. It has no tools, and it bills like any run.{billing?.billing === "none" && <> Runs use your <Link className="underline underline-offset-4" to="models">model keys</Link>.</>}</>}>
        <Playground agents={onboarding.agents.data} onRan={reload} />
      </StepCard>
      <StepCard n={2} title="Create an API key" done={!!key || keyStep.done}
        description={<>Your application uses it to create and run agents. <LearnMore page="authentication" /></>}>
        <CreateKey count={onboarding.tokens.data?.length ?? 0} created={key} onCreated={token => { setKey(token); void onboarding.tokens.reload(); }} />
      </StepCard>
      <StepCard n={3} title="Run an agent with your own tool" done={codeStep.done}
        description="Your tools are ordinary functions in your process. The runtime runs the model loop, keeps the agent's history and sandboxes code the model writes. Run it again and the agent remembers.">
        <Tabs defaultValue="typescript">
          <TabsList><TabsTrigger value="typescript">TypeScript</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger><TabsTrigger value="rest">curl</TabsTrigger></TabsList>
          <TabsContent value="typescript" className="flex flex-col gap-3 pt-3"><CodeBlock language="shell" code={code.install.typescript} /><CodeBlock language="ts" code={code.typescript} /><p className="text-muted-foreground">Node 22 or later, or Bun.</p></TabsContent>
          <TabsContent value="python" className="flex flex-col gap-3 pt-3"><CodeBlock language="shell" code={code.install.python} /><CodeBlock language="python" code={code.python} /><p className="text-muted-foreground">Python 3.11 or later. The SDK is async.</p></TabsContent>
          <TabsContent value="rest" className="flex flex-col gap-3 pt-3"><CodeBlock language="shell" code={code.install.rest} /><CodeBlock language="shell" code={code.rest} /></TabsContent>
        </Tabs>
      </StepCard>
      <Card>
        <CardHeader>
          <CardTitle>Or let your coding agent set it up</CardTitle>
          <CardDescription>Paste this into Claude Code, Codex, Cursor or any coding agent, with what the agent should do. It installs the SDK, has you put a key in <code>.env.local</code> (never in the chat) and runs it. Or connect it to camelRun's MCP server and sign in, with no key.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3"><CodeBlock language="prompt" code={code.prompt} /><CodeBlock language="shell" code={code.mcp} /></CardContent>
      </Card>
      <NextSteps />
    </div>
  );
}

export function NextSteps({ children }: { children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What's next</CardTitle>
        <CardDescription>The docs are also Markdown for your coding agent, at <a className="underline underline-offset-4" href="/llms.txt">/llms.txt</a>.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {children}
          <li><LearnMore page="tools">Tools</LearnMore>: your functions, MCP servers, OpenAPI and built-ins</li>
          <li><LearnMore page="channels">Channels</LearnMore>: Slack, Telegram, Discord, GitHub and webhooks</li>
          <li><LearnMore page="definitions">Definitions</LearnMore>: one configuration for many agents</li>
          <li><LearnMore page="models-and-keys">Models and keys</LearnMore>: choose a model, or bring your own key</li>
          <li><LearnMore page="pricing">Pricing</LearnMore>: what runs and storage cost</li>
          <li><LearnMore page="production">Production checklist</LearnMore></li>
        </ul>
      </CardContent>
    </Card>
  );
}
