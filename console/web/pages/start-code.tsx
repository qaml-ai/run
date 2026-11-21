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
import { api, type AgentSummary, type RunRecord } from "@/lib/api";
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
      <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-done={step.done || undefined}
            className={cn("flex items-center gap-2 text-sm", step.done ? "text-foreground" : "text-muted-foreground")}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center border font-mono text-[10px]",
                step.done && "border-[var(--chart-1)] text-[var(--chart-1)]",
              )}
            >
              {step.done ? <Check className="size-3" /> : index + 1}
            </span>
            {step.label}
            <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function StepCard({
  n,
  title,
  description,
  done,
  children,
}: {
  n: number;
  title: string;
  description?: ReactNode;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-5 items-center justify-center border font-mono text-[10px]",
              done && "border-[var(--chart-1)] text-[var(--chart-1)]",
            )}
          >
            {done ? <Check className="size-3" aria-label="done" /> : n}
          </span>
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="flex flex-col gap-3">{children}</CardContent>}
    </Card>
  );
}

/** Quickstart snippets targeting CamelRun v2 (`/v2/*`) and `cr_live_*` keys. */
export function snippets(url: string, key?: string) {
  const env = `export CAMELAI_API_KEY=${key ?? "cr_live_...   # create a key in step 2"}`;
  return {
    install: {
      typescript: env,
      python: `pip install httpx\n${env}`,
      rest: env,
    },
    typescript: `// agent.mjs: run with node agent.mjs
const BASE = "${url}";
const headers = {
  Authorization: \`Bearer \${process.env.CAMELAI_API_KEY}\`,
  "Content-Type": "application/json",
};

// Upsert a keyed durable agent (same key = same agent & history)
const agent = await fetch(\`\${BASE}/v2/agents/quickstart\`, {
  method: "PUT",
  headers,
  body: JSON.stringify({
    instructions: "You are a concise assistant.",
    builtins: ["files", "web_fetch"],
  }),
}).then(r => r.json());

// Run a turn and wait for the completed result
const run = await fetch(\`\${BASE}/v2/agents/\${agent.id}/runs\`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    prompt: "Write a haiku about durable agents.",
    wait: true,
  }),
}).then(r => r.json());

console.log(run.text);`,
    python: `# agent.py: run with python agent.py
import os, httpx

BASE = "${url}"
headers = {"Authorization": f"Bearer {os.environ['CAMELAI_API_KEY']}"}

with httpx.Client(base_url=BASE, headers=headers, timeout=120) as client:
    agent = client.put("/v2/agents/quickstart", json={
        "instructions": "You are a concise assistant.",
        "builtins": ["files", "web_fetch"],
    }).json()

    run = client.post(f"/v2/agents/{agent['id']}/runs", json={
        "prompt": "Write a haiku about durable agents.",
        "wait": True,
    }).json()
    print(run["text"])`,
    rest: `BASE=${url}; AUTH="Authorization: Bearer $CAMELAI_API_KEY"

# Upsert a keyed durable agent
curl -s -X PUT $BASE/v2/agents/quickstart -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"instructions": "You are a concise assistant."}' | jq .

# Send a prompt and wait for completion
curl -s -X POST $BASE/v2/agents/quickstart/runs -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"prompt": "Write a haiku about durable agents.", "wait": true}' | jq -r '.text // .error.message'`,
  };
}

export const PLAYGROUND_PROMPT = "In three short sentences, explain what a durable agent is. Then write a haiku about one.";

export function Playground({ agents, onRan }: { agents?: AgentSummary[]; onRan: () => void }) {
  const [draft, setDraft] = useState(PLAYGROUND_PROMPT);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string>();
  const [agentId, setAgentId] = useState<string>();
  const [error, setError] = useState<string>();

  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setReply(undefined);
    try {
      let id = agents?.find(agent => agent.key === PLAYGROUND_KEY)?.id;
      if (!id) {
        const created = await api<{ id: string }>(`/v2/agents/${PLAYGROUND_KEY}`, {
          method: "PUT",
          body: {
            instructions: "You are a friendly, concise assistant answering in the camelRun console's playground.",
            builtins: [],
          },
        });
        id = created.id;
      }
      setAgentId(id);
      let record = await api<RunRecord>(`/v2/agents/${encodeURIComponent(id)}/runs`, {
        method: "POST",
        body: { prompt: draft.trim(), wait: true },
      });
      onRan();
      while (record.status === "queued" || record.status === "running") {
        await new Promise(resolve => setTimeout(resolve, 1000));
        record = await api<RunRecord>(`/v2/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(record.id)}`);
      }
      if (record.error) setError(record.error.message);
      if (!record.error || record.text) setReply(record.text ?? "");
      onRan();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={run} className="flex flex-col gap-3">
      <Label htmlFor="playground-prompt" className="sr-only">Prompt</Label>
      <Textarea id="playground-prompt" rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !draft.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          {busy ? "Running…" : "Run"}
        </Button>
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

function CreateKey({ count, created, onCreated }: { count: number; created?: string; onCreated: (token: string) => void }) {
  const [name, setName] = useState("Quickstart");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ token: string }>("/v2/tokens", { method: "POST", body: { name: name.trim() } });
      onCreated(res.token);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="bg-card border-foreground/40 border p-3">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>SHOWN ONCE</Eyebrow>
          <CopyButton value={created} label="Copy key" />
        </div>
        <code className="mt-1 block font-mono text-xs leading-relaxed break-all">{created}</code>
        <p className="text-muted-foreground mt-2 text-xs">
          It&apos;s filled into the code below until you leave this page. Keep it on your backend: never ship it to a browser or mobile app.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={create} className="flex flex-col gap-2">
      <ErrorAlert error={error} className="mb-0" />
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start-key-name">Key name</Label>
          <Input id="start-key-name" className="w-56" value={name} onChange={event => setName(event.target.value)} />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Create API key
        </Button>
      </div>
      {count > 0 && (
        <p className="text-muted-foreground text-xs">
          You have {count} key{count === 1 ? "" : "s"} already (<Link className="underline underline-offset-4" to="tokens">API keys</Link>). A key is shown only when created, so make one here to have it filled in below.
        </p>
      )}
    </form>
  );
}

export function CodePath({ onboarding }: { onboarding: ReturnType<typeof useOnboarding> }) {
  const [key, setKey] = useState<string>();
  const url = location.origin;
  const code = snippets(url, key);
  const [tryStep, keyStep, codeStep] = onboarding.code;
  const reload = () => {
    void onboarding.agents.reload();
    void onboarding.usage.reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <Checklist label="YOUR FIRST AGENT" steps={onboarding.code} />
      <StepCard
        n={1}
        title={tryStep.label}
        done={tryStep.done}
        description="No code: this creates an agent keyed playground on your account's default model and runs your prompt."
      >
        <Playground agents={onboarding.agentList} onRan={reload} />
      </StepCard>
      <StepCard
        n={2}
        title={keyStep.label}
        done={!!key || keyStep.done}
        description={<>Your application uses a <span className="font-mono">cr_live_*</span> key to create and run agents. <LearnMore page="authentication" /></>}
      >
        <CreateKey
          count={onboarding.tokenList?.length ?? 0}
          created={key}
          onCreated={token => {
            setKey(token);
            void onboarding.tokens.reload();
          }}
        />
      </StepCard>
      <StepCard
        n={3}
        title={codeStep.label}
        done={codeStep.done}
        description="Every agent is addressed by key via PUT /v2/agents/:key. Run it again and the agent remembers its full conversation and Git-backed workspace."
      >
        <Tabs defaultValue="typescript">
          <TabsList>
            <TabsTrigger value="typescript">TypeScript</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
            <TabsTrigger value="rest">curl</TabsTrigger>
          </TabsList>
          <TabsContent value="typescript" className="flex min-w-0 flex-col gap-3 pt-3">
            <CodeBlock language="shell" code={code.install.typescript} />
            <CodeBlock language="ts" code={code.typescript} />
          </TabsContent>
          <TabsContent value="python" className="flex min-w-0 flex-col gap-3 pt-3">
            <CodeBlock language="shell" code={code.install.python} />
            <CodeBlock language="python" code={code.python} />
          </TabsContent>
          <TabsContent value="rest" className="flex min-w-0 flex-col gap-3 pt-3">
            <CodeBlock language="shell" code={code.install.rest} />
            <CodeBlock language="shell" code={code.rest} />
          </TabsContent>
        </Tabs>
      </StepCard>
      <NextSteps />
    </div>
  );
}

export function NextSteps({ children }: { children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What&apos;s next</CardTitle>
        <CardDescription>
          Explore the rest of the CamelRun v2 documentation, or read it in Markdown at <a className="underline underline-offset-4" href="/llms.txt">/llms.txt</a>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {children}
          <li><LearnMore page="tools">Tools</LearnMore>: custom webhooks, MCP servers and built-in suites</li>
          <li><LearnMore page="channels">Channels</LearnMore>: Slack, email and HTTP inbound triggers</li>
          <li><LearnMore page="definitions">Definitions</LearnMore>: reusable configuration slugs for agents</li>
          <li><LearnMore page="models-and-keys">Models and keys</LearnMore>: choose a model, or bring your own key</li>
          <li><LearnMore page="pricing">Pricing</LearnMore>: prepaid credits and metered usage</li>
          <li><LearnMore page="production">Production checklist</LearnMore></li>
        </ul>
      </CardContent>
    </Card>
  );
}
