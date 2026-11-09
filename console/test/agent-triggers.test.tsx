import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentTriggers } from '../web/pages/agent-triggers';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('creates a signed trigger and shows its one-time URL until dismissed',async()=>{
 const writes:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return Response.json({id:'t',url:'https://example.test/v1/hooks/opaque'});}
  return Response.json([]);
 }));
 render(<AgentTriggers agentId="client_a"/>);
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Support'}});
 fireEvent.change(screen.getByLabelText('Instructions'),{target:{value:'Triage this event'}});
 fireEvent.change(screen.getByLabelText('Verification'),{target:{value:'github'}});
 fireEvent.change(screen.getByLabelText('Signing secret'),{target:{value:'a-test-signing-secret'}});
 fireEvent.click(screen.getByRole('button',{name:'Create trigger'}));
 await waitFor(()=>expect(writes).toEqual([{name:'Support',prompt:'Triage this event',mode:'continue',budget:{usd:1},verify:{type:'github',secret:'a-test-signing-secret'}}]));
 expect(await screen.findByDisplayValue('https://example.test/v1/hooks/opaque')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));
 expect(screen.queryByDisplayValue('https://example.test/v1/hooks/opaque')).toBeNull();
 expect((screen.getByLabelText('Signing secret') as HTMLInputElement).value).toBe('');
});
