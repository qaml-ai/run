import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { AgentSchedules } from "../web/pages/agent-schedules";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("creates a weekday calendar schedule with email without writing code",async()=>{
 const writes:any[]=[];
 vi.stubGlobal("fetch",vi.fn(async(path:string,init?:RequestInit)=>{if(init?.method==="POST")writes.push(JSON.parse(String(init.body)));return new Response("[]",{headers:{"Content-Type":"application/json"}});}));
 render(<AgentSchedules agentId="client_a"/>);
 fireEvent.change(screen.getByLabelText("What should the agent do?"),{target:{value:"Write the daily report"}});
 fireEvent.change(screen.getByLabelText("Repeat"),{target:{value:"weekdays"}});
 fireEvent.change(screen.getByLabelText("Time zone"),{target:{value:"America/Chicago"}});
 fireEvent.change(screen.getByLabelText("Email recipient"),{target:{value:"reader@example.com"}});
 fireEvent.change(screen.getByLabelText("Email format"),{target:{value:"html"}});
 fireEvent.click(screen.getByRole("button",{name:"Create schedule"}));
 await waitFor(()=>expect(writes).toEqual([{text:"Write the daily report",history:"none",calendar:{time:"08:00",timeZone:"America/Chicago",daysOfWeek:[1,2,3,4,5]},email:{to:"reader@example.com",subject:"Agent report",format:"html"}}]));
});
