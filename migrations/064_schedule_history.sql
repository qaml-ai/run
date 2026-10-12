-- What a schedule's prompt shows the model of the agent's history: null for all of it, 'none' for only the system
-- prompt and the prompt itself (a prompt's history: "none"), so a periodic agent's wake-ups do not read ever more.
alter table schedules add column history text;
