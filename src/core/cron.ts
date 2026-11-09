/** Five-field numeric cron in a named time zone. Missing DST minutes are skipped; repeated minutes run twice. */
export interface Cron { expression: string; timeZone: string }
function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('Invalid cron field');
    const step = Number(match[2] ?? 1);
    const [start, end] = match[1] === '*' ? [min, max] : match[1].includes('-') ? match[1].split('-').map(Number) : [Number(match[1]), match[2] ? max : Number(match[1])];
    if (!Number.isInteger(step) || step < 1 || start < min || end > max || end < start) throw new Error('Invalid cron range or step');
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
function fields(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron.expression must have five fields');
  return { parts, values: parts.map((part, i) => field(part, [0,0,1,1,0][i], [59,23,31,12,7][i])) };
}
export function cronInput(value: any): Cron {
  if (!value || typeof value.expression !== 'string' || typeof value.timeZone !== 'string' || !value.timeZone || /^[+-]/.test(value.timeZone)) throw new Error('cron needs expression and IANA timeZone');
  fields(value.expression);
  try { new Intl.DateTimeFormat('en', {timeZone:value.timeZone}).format(); } catch { throw new Error('Invalid cron timeZone'); }
  const cron = {expression:value.expression.trim(), timeZone:value.timeZone};
  nextCron(cron, Date.UTC(2024,0,1)); // Reject impossible dates, including February 30.
  return cron;
}
export function nextCron(cron: Cron, after: number): number {
  const {parts, values:[minutes,hours,days,months,weekdays]} = fields(cron.expression);
  const fmt = new Intl.DateTimeFormat('en-US', {timeZone:cron.timeZone, year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});
  // Search calendar days, then resolve only matching wall minutes through the zone's offsets.
  const wall = (ms:number) => { const p=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value])); return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute); };
  const start = new Date(wall(after)); start.setUTCHours(0,0,0,0);
  for(let i=0;i<366*8;i++) {
    const date=new Date(+start+i*86400000), dow=date.getUTCDay();
    const dom=days.has(date.getUTCDate()), week=weekdays.has(dow)||(dow===0&&weekdays.has(7));
    if(!months.has(date.getUTCMonth()+1) || !(parts[2]==='*'?week:parts[4]==='*'?dom:dom||week)) continue;
    const offsets=new Set<number>();
    for(let h=-36;h<=36;h+=6) {const ms=+date+h*3600000;offsets.add(wall(ms)-ms);}
    const candidates:number[]=[];
    for(const h of hours) for(const m of minutes) {const target=+date+h*3600000+m*60000; for(const offset of offsets) {const ms=target-offset;if(ms>after&&wall(ms)===target)candidates.push(ms);}}
    if(candidates.length)return Math.min(...candidates);
  }
  throw new Error('No cron occurrence within eight years');
}

/** Every possible minute pair, including wraparound between hours, must be five minutes apart for fresh mode. */
export function freshCronAllowed(cron: Cron): boolean {
  const {values:[minutes,hours]} = fields(cron.expression);
  const times = [...hours].flatMap(hour => [...minutes].map(minute => hour * 60 + minute)).sort((a,b)=>a-b);
  return times.every((time,index) => (index ? time-times[index-1] : time+1440-times[times.length-1]) >= 5);
}
