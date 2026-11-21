import { useState, type FormEvent } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, ErrorAlert } from "@/components/common";
import { api, formatTime, useApi, type ScheduleRecord } from "@/lib/api";

export function AgentSchedules({ agentId }: { agentId: string }) {
  const base = `/v2/agents/${encodeURIComponent(agentId)}/schedules`;
  const res = useApi<{ schedules: ScheduleRecord[] }>(base, 15_000);
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"interval" | "cron">("cron");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [intervalSeconds, setIntervalSeconds] = useState("3600");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const body =
        kind === "cron"
          ? { prompt: prompt.trim(), cronExpr: cronExpr.trim() }
          : { prompt: prompt.trim(), intervalSeconds: Number(intervalSeconds) };
      await api(base, { method: "POST", body });
      setPrompt("");
      await res.reload();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(scheduleId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`${base}/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
      await res.reload();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const schedules = res.data?.schedules ?? [];

  return (
    <div className="space-y-6">
      <ErrorAlert error={error ?? res.error} />
      <form className="max-w-2xl space-y-3" onSubmit={submit}>
        <h2 className="text-base font-semibold">Add a schedule</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-prompt">Prompt</Label>
          <Textarea
            id="schedule-prompt"
            rows={3}
            placeholder="Summarize today's updates and write a report to reports/daily.md"
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Cadence</Label>
            <Select value={kind} onValueChange={value => setKind(value as "interval" | "cron")}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron (UTC)</SelectItem>
                <SelectItem value="interval">Interval (seconds)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "cron" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-cron">Cron expression</Label>
              <Input
                id="schedule-cron"
                className="w-48 font-mono text-xs"
                placeholder="0 9 * * *"
                value={cronExpr}
                onChange={event => setCronExpr(event.target.value)}
                required
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-interval">Every (seconds)</Label>
              <Input
                id="schedule-interval"
                type="number"
                min={60}
                className="w-36 font-mono text-xs"
                value={intervalSeconds}
                onChange={event => setIntervalSeconds(event.target.value)}
                required
              />
            </div>
          )}
        </div>
        <Button type="submit" size="sm" disabled={busy || !prompt.trim()}>
          {busy && <Loader2 className="animate-spin" />}Create schedule
        </Button>
      </form>

      <section>
        <h2 className="mb-2 text-base font-semibold">Schedules</h2>
        {schedules.length === 0 ? (
          <p className="text-muted-foreground text-sm">No schedules yet.</p>
        ) : (
          <div className="space-y-2">
            {schedules.map(s => (
              <div key={s.id} className="bg-card flex items-start justify-between gap-4 border p-3">
                <div className="min-w-0">
                  <p className="text-sm whitespace-pre-wrap">{s.prompt}</p>
                  <p className="text-muted-foreground mt-1 font-mono text-xs">
                    {s.cronExpr ? `cron ${s.cronExpr}` : s.intervalSeconds ? `every ${s.intervalSeconds}s` : "scheduled"} · next {formatTime(s.nextDueAt)}
                  </p>
                </div>
                <ConfirmButton
                  size="xs"
                  variant="outline"
                  label="Delete"
                  icon={<Trash2 />}
                  title="Delete this schedule?"
                  description="Future scheduled runs for this entry will stop."
                  confirm="Delete schedule"
                  onConfirm={() => remove(s.id)}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
