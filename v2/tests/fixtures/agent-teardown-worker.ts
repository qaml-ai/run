import { AgentDO } from "../../worker/src/agent-do.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((resume) => { resolve = resume; });
  return { promise, resolve };
}

export class TeardownTestAgent extends AgentDO {
  private afterAbort?: () => void;

  override async abortRuns(body?: { keepQueued?: boolean; supersedeInputs?: boolean }) {
    const result = await super.abortRuns(body);
    this.afterAbort?.();
    return result;
  }

  private pauseNextAlarmSchedule() {
    const internals = this as unknown as { scheduleNextAlarm(): Promise<void> };
    const schedule = internals.scheduleNextAlarm.bind(this);
    const paused = barrier();
    const proceed = barrier();
    internals.scheduleNextAlarm = async () => {
      internals.scheduleNextAlarm = schedule;
      await schedule();
      paused.resolve();
      await proceed.promise;
    };
    return { paused: paused.promise, resume: proceed.resolve };
  }

  private runsTableExists(): boolean {
    return this.ctx.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    ).toArray().length !== 0;
  }

  async deleteWhileAlarmIsPaused() {
    await this.initAgent({ id: "agent", tenantId: "tenant", key: "agent", model: "fixture/model" });
    // Hold the alarm after persisting storage and before it starts a queue drain.
    const gate = this.pauseNextAlarmSchedule();
    const alarm = this.alarm();
    await gate.paused;

    const { deleted } = await this.destroyAgent();
    gate.resume();
    await alarm;
    return { deleted, alarmFinished: true, storageEmpty: !this.runsTableExists() };
  }

  async deleteWhileAdmissionIsPaused() {
    await this.initAgent({ id: "agent", tenantId: "tenant", key: "agent", model: "fixture/model" });
    const gate = this.pauseNextAlarmSchedule();
    const admitted = this.startRun({ prompt: "Fixture run", wait: true });
    await gate.paused;

    const { deleted } = await this.destroyAgent();
    gate.resume();
    const run = await admitted;
    return { deleted, status: run.status, storageEmpty: !this.runsTableExists() };
  }

  async deleteWhileDrainIsPaused() {
    await this.initAgent({ id: "agent", tenantId: "tenant", key: "agent", model: "fixture/model" });
    this.ctx.storage.sql.exec(
      "INSERT INTO runs (id, status, prompt, started_at) VALUES ('fixture-run', 'queued', 'Fixture run', 0)",
    );
    const internals = this as unknown as {
      drainRunQueue(): Promise<void>;
      executeSingleRunWithLease(): Promise<void>;
    };
    const terminal = barrier();
    const proceed = barrier();
    internals.executeSingleRunWithLease = async () => {
      this.ctx.storage.sql.exec("UPDATE runs SET status = 'completed' WHERE id = 'fixture-run'");
      terminal.resolve();
      await proceed.promise;
    };
    const drain = internals.drainRunQueue();
    await terminal.promise;
    const abortStarted = barrier();
    this.afterAbort = abortStarted.resolve;
    const deletion = this.destroyAgent();
    // Let the unfenced implementation finish its deletion. The fenced one
    // announces that it has tried to cancel work and can now wait for the drain.
    const deletedEarly = await Promise.race([
      deletion.then(() => true),
      abortStarted.promise.then(() => false),
    ]);
    proceed.resolve();
    const [{ deleted }] = await Promise.all([deletion, drain]);
    return { deleted, deletedEarly, storageEmpty: !this.runsTableExists() };
  }

  async settleAfterDestroyOrMissingRun() {
    await this.initAgent({ id: "agent", tenantId: "tenant", key: "agent", model: "fixture/model" });
    const internals = this as unknown as {
      ensurePiEngine(): { host: { onRunSettled: (runId: string) => void } };
    };
    const host = internals.ensurePiEngine().host;
    // Missing run row while agent is still live must not throw ApiError('Run ... not found').
    host.onRunSettled("run_missing_before_destroy");
    const { deleted } = await this.destroyAgent();
    // Late settlement callback firing after destroyAgent() must be a safe no-op.
    host.onRunSettled("run_settled_after_destroy");
    return { deleted, settledSafely: true, storageEmpty: !this.runsTableExists() };
  }
}

export default {
  async fetch(request: Request, env: { TEST_AGENT: DurableObjectNamespace<TeardownTestAgent> }) {
    const mode = new URL(request.url).pathname;
    const stub = env.TEST_AGENT.getByName(mode);
    try {
      if (mode === "/alarm") return Response.json(await stub.deleteWhileAlarmIsPaused());
      if (mode === "/admission") return Response.json(await stub.deleteWhileAdmissionIsPaused());
      if (mode === "/drain") return Response.json(await stub.deleteWhileDrainIsPaused());
      if (mode === "/settled") return Response.json(await stub.settleAfterDestroyOrMissingRun());
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ message: String(error) }, { status: 500 });
    }
  },
};
