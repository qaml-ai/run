interface CanaryEnv {
  CAMELRUN_URL: string;
  CANARY_API_TOKEN: string;
}

export async function probeTurn(env: CanaryEnv, scheduledTime: number): Promise<void> {
  const started = Date.now();
  const agent = `/agents/turn-watch-${scheduledTime}`;
  const signal = AbortSignal.timeout(30_000);
  let runId: string | undefined;
  let stage = "agent";

  async function request(method: string, path: string, body?: unknown, accept = "application/json") {
    const response = await fetch(env.CAMELRUN_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.CANARY_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: accept,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  }

  try {
    await (await request("PUT", agent, { model: "mock/default", builtins: [] })).body?.cancel();
    stage = "accept";
    const accepted = await (await request("POST", `${agent}/runs`, {
      prompt: "CamelRun turn health check",
      wait: false,
      idempotencyKey: `turn-watch-${scheduledTime}`,
    })).json<{ id?: string }>();
    runId = accepted.id;
    if (!runId) throw new Error("Missing run ID");

    stage = "stream";
    const stream = await request("GET", `${agent}/events?runId=${encodeURIComponent(runId)}`, undefined, "text/event-stream");
    const events = await stream.text();
    for (const event of ["run_queued", "run_started", "run_completed"]) {
      if (!events.includes(`\nevent: ${event}\n`)) throw new Error(`Missing ${event} event`);
    }

    stage = "settlement";
    const result = await (await request("GET", `${agent}/runs/${encodeURIComponent(runId)}`)).json<{
      id: string; status: string; text: string;
    }>();
    if (result.id !== runId || result.status !== "completed" || !result.text) {
      throw new Error("Missing completed turn record");
    }

    stage = "cleanup";
    await (await request("DELETE", agent)).body?.cancel();
    console.info("Agent turn canary passed", { event: "turn_canary_passed", runId, elapsedMs: Date.now() - started });
  } catch (error) {
    console.error("Agent turn canary failed", {
      event: "turn_canary_failed", stage, runId, scheduledTime, elapsedMs: Date.now() - started,
    });
    throw error;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: CanaryEnv): Promise<void> {
    await probeTurn(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<CanaryEnv>;
