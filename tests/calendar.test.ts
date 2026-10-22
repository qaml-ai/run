import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarInput, nextCalendar, calendarPrompt } from "../src/calendar.ts";
const next = (after: string, time = "08:00", daysOfWeek?: number[]) => new Date(nextCalendar(calendarInput({time,timeZone:"America/Chicago",daysOfWeek}),Date.parse(after))).toISOString();
test("calendar schedules keep Chicago wall time across DST and skip weekends", () => {
 assert.equal(next("2026-10-31T14:00:00Z"),"2026-11-01T14:00:00.000Z");
 assert.equal(next("2026-03-07T15:00:00Z"),"2026-03-08T13:00:00.000Z");
 assert.equal(next("2026-10-30T13:00:00Z","08:00",[1,2,3,4,5]),"2026-11-02T14:00:00.000Z");
 assert.equal(next("2026-10-22T13:00:00Z"),"2026-10-23T13:00:00.000Z");
});
test("a missing DST time is skipped and a repeated time runs only once", () => {
 assert.equal(next("2026-03-08T06:00:00Z","02:30"),"2026-03-09T07:30:00.000Z");
 assert.equal(next("2026-11-01T05:00:00Z","01:30"),"2026-11-01T06:30:00.000Z");
 assert.equal(next("2026-11-01T06:30:00Z","01:30"),"2026-11-02T07:30:00.000Z");
 const c=calendarInput({time:"08:00",timeZone:"Asia/Kathmandu"});
 assert.equal(new Date(nextCalendar(c,Date.parse("2026-10-22T00:00:00Z"))).toISOString(),"2026-10-22T02:15:00.000Z");
});
test("invalid calendar inputs are rejected", () => {
 for(const c of [{time:"25:00",timeZone:"UTC"},{time:"08:00",timeZone:"not-a-zone"},{time:"08:00",timeZone:"UTC",daysOfWeek:[]},{time:"08:00",timeZone:"UTC",daysOfWeek:[1,1]}]) assert.throws(()=>calendarInput(c));
});

test("calendar wake-ups supply their fixed local edition date, including across a UTC day boundary", () => {
 const text=calendarPrompt("Write a report",{time:"23:30",timeZone:"America/Chicago"},Date.parse("2026-10-23T04:30:00Z"));
 assert.match(text,/local edition date is 2026-10-22 in America\/Chicago/);
 assert.match(text,/2026-10-23T04:30:00.000Z/);
 assert.ok(text.startsWith("Write a report\n"));
});
