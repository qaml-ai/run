import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../../../src/client-sessions/events.ts', import.meta.url), 'utf8');
const begin = source.indexOf('/** Keep the running turn as its events fold');
const end = source.indexOf('\n/**', source.indexOf('export function turnSnapshot', begin));
if (begin < 0 || end < 0) throw new Error('Event snapshot extraction boundary changed');
const sessions = await readFile(new URL('../../../src/client-sessions.ts', import.meta.url), 'utf8');
const replay = sessions.slice(sessions.indexOf('  private replay('), sessions.indexOf('\n  private busy(', sessions.indexOf('  private replay('))).replace('  private replay(', 'export function replay(').replace('events.turnSnapshot(this.eventContext, session)', 'turnSnapshot({ options: {} }, session)');
const limit = source.match(/export const TURN_SNAPSHOT_BYTES = [^;]+;/)[0];
const text = `// Generated from src/client-sessions/events.ts; only host types change.\nimport { HttpError } from './errors.ts';\nimport { FRAME_BYTES, type ClientEvent, type TurnSnapshot } from '../../../shared/client-protocol.ts';\nexport type LiveTurn = { requestId: string; start?: number; count: number; bytes: number; messages: any[]; truncated?: boolean };\ntype BufferedEvent = { id: number; data: any };\ntype Session = { events: BufferedEvent[]; cursor: number; turn?: LiveTurn; partial?: any };\ntype EventContext = { options: { snapshotBytes?: number } };\n${limit}\n${source.slice(begin,end)}\n${replay}\n`;
const path = new URL('../src/live-event-policy.ts',import.meta.url);
if(process.argv.includes('--check')) { if(await readFile(path,'utf8')!==text) throw new Error('Live event policy drifted'); }
else await writeFile(path,text);
