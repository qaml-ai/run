import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import { HttpError } from './errors.ts';
import { safeError } from './observability.ts';
import type { Schedule } from './schedule-policy.ts';

export type ScheduleToolsHost = {
  create(input: Record<string, unknown>): Promise<Schedule>;
  list(): Promise<Schedule[]>;
  cancel(id: string): Promise<boolean>;
};

const definitions = [
  {
    name: 'schedule',
    description: 'Schedule a wake-up for yourself: at the time given, you receive `text` as a new message and can act on it. Give inSeconds or at (an ISO time); everySeconds (at least 60) repeats it. Or give calendar: local HH:MM, IANA timeZone and optional daysOfWeek (Sunday 0 to Saturday 6), respecting daylight saving time. Do not combine calendar with other timing fields. Returns its id.',
    parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', minLength: 1, maxLength: 32_000, description: 'The message you will receive' },
      calendar: { type: 'object', additionalProperties: false, required: ['time', 'timeZone'], properties: { time: { type: 'string' }, timeZone: { type: 'string' }, daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } } } },
      inSeconds: { type: 'number', minimum: 0 }, at: { type: 'string', description: 'ISO 8601 time' }, everySeconds: { type: 'integer', minimum: 60 },
      history: { type: 'string', enum: ['full', 'none'], description: "Ignored; every run sees the agent's history" },
    } },
  },
  { name: 'list_schedules', description: 'List your scheduled wake-ups.', parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'cancel_schedule', description: 'Cancel one of your scheduled wake-ups by id.', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } } },
];

/** The tool result matches src/builtins.ts; the HTTP schedule view keeps epoch milliseconds. */
function view(schedule: Schedule) {
  return {
    id: schedule.id, ...(schedule.calendar ? { calendar: schedule.calendar } : {}),
    ...(schedule.text !== undefined ? { text: schedule.text } : { code: schedule.code }),
    dueAt: new Date(schedule.dueAt).toISOString(),
    ...(schedule.everySeconds ? { everySeconds: schedule.everySeconds } : {}),
    ...(schedule.failures ? { failures: schedule.failures } : {}),
    ...(schedule.lastError !== undefined ? { lastError: schedule.lastError } : {}),
  };
}

export function agentScheduleTools(builtins: string[] | undefined, host?: ScheduleToolsHost): ToolRegistration[] {
  if (!builtins?.includes('schedule') || !host) return [];
  return definitions.map(definition => {
    const check = compile(definition.parameters as never);
    return defineTool({ ...definition, parameters: definition.parameters as never, structuredOutputSchema: {}, replay: 'safe', execute: async (args: Record<string, unknown>) => {
      if (!(check.check as (value: unknown) => boolean)(args)) throw new HttpError(400, `Invalid ${definition.name} arguments`);
      const value = definition.name === 'schedule' ? view(await host.create(args))
        : definition.name === 'list_schedules' ? { schedules: (await host.list()).map(view) }
        : { cancelled: await host.cancel(String(args.id)) };
      return { output: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value, structuredOutput: value };
    } });
  });
}

export function scheduleError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  return status === undefined ? safeError(error) : `HTTP ${status}: ${safeError(error)}`;
}
