import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminAnalytics } from "../web/pages/admin-analytics";
import { AdminActivityTrend } from "../web/pages/admin-activity-trend";
import { parseReportRequest, presetRange } from "../web/lib/admin-range";

const range={start_date:"2026-10-08",end_date:"2026-10-08",time_zone:"America/Chicago"};
const base={schema_version:1,range,generated_at:"2026-10-08T17:00:00Z",coverage:{first_event_at:"2026-10-01T15:00:00Z",last_event_at:"2026-10-08T16:00:00Z"}};
const trend={schema_version:1,range:{start_date:"2026-09-25",end_date:"2026-10-08",time_zone:"UTC"},generated_at:base.generated_at,daily:[{date:"2026-10-07",signups:4,returning_active:3},{date:"2026-10-08",signups:2,returning_active:5}],incomplete_date:"2026-10-08"};
const row={page_type:"product",title:"camelRun",page_path:"/run",page_url:"https://www.camelai.com/run",published_on:null,visitors:100,page_views:200,run_click_visitors:20,run_clicks:30,signups:50,signups_activated:10,signups_paying:3,new_visitors:10,new_visitor_signups:2};
const empty={...row,page_type:"article",title:"A future Run post",page_path:"/blog/future-run-post",page_url:"https://www.camelai.com/blog/future-run-post",published_on:"2026-11-01",visitors:0,page_views:0,run_click_visitors:0,run_clicks:0,signups:0,signups_activated:0,signups_paying:0,new_visitors:0,new_visitor_signups:0};
const pages={...base,kind:"pages",pages:[row,empty],totals:row,signup_attribution:{total:60,run_pages:50,other_pages:7,not_captured:3}};
const signals={...base,summary:{signups:2,activations:null,payments:1,paying_accounts:1,amount_minor:2500,currency:"USD"},daily:[],activation_coverage:{status:"unavailable",since:null}};
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-08T17:00:00Z"));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});

test("Run pages use the selected rolling range and a true new-browser denominator, retaining zero rows",async()=>{
 const requests:any[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
  if(url.startsWith("/api/activity-trend"))return Response.json(trend);
  if(url.startsWith("/api/product-signals"))return Response.json(signals);
  const body=JSON.parse(String(init.body));requests.push(body);return Response.json({...pages,range:body});
 }));
 const user=userEvent.setup();render(<AdminAnalytics/>);
 await screen.findByText("1 paying account · $25.00 purchased");
 await user.click(screen.getByRole("tab",{name:"Run pages"}));
 await screen.findByRole("link",{name:"camelRun"});
 fireEvent.change(screen.getByLabelText("Calendar preset"),{target:{value:"last-7"}});
 await waitFor(()=>expect(requests.at(-1)).toMatchObject({kind:"pages",start_date:"2026-10-02",end_date:"2026-10-08"}));
 const performance=screen.getByRole("region",{name:"Run page performance"});
 expect(within(performance).getByText("20%")).toBeTruthy();
 expect(within(performance).queryByText("50%")).toBeNull();
 expect(within(performance).getByText("2 / 10 new browsers")).toBeTruthy();
 expect(within(performance).getByText("—")).toBeTruthy();
 expect(within(performance).getByText("Scheduled · 2026-11-01")).toBeTruthy();
 expect(within(performance).getByRole("link",{name:"camelRun"}).getAttribute("href")).toBe("https://www.camelai.com/run");
 fireEvent.change(screen.getByLabelText("Calendar preset"),{target:{value:"last-14"}});
 await waitFor(()=>expect(requests.at(-1).start_date).toBe("2026-09-25"));
 expect(requests.every(request=>request.time_zone==="America/Chicago"&&!request.cursor&&!request.account_ref)).toBe(true);
});

test("a pages connection failure shows unavailable rather than zero traffic",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.startsWith("/api/activity-trend")?Response.json(trend):url.startsWith("/api/product-signals")?Response.json(signals):Response.json({error:"report_not_configured"},{status:503})));
 const user=userEvent.setup();render(<AdminAnalytics/>);
 await user.click(screen.getByRole("tab",{name:"Run pages"}));
 await screen.findByText("Waiting for the tracking connection");
 expect(screen.queryByRole("heading",{name:"Recorded visitors"})).toBeNull();
});

test("the UTC trend exposes both series, exact focus values, and today's provisional status",async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json(trend));vi.stubGlobal("fetch",fetcher);
 render(<AdminActivityTrend refresh={0}/>);
 const point=await screen.findByRole("button",{name:"2026-10-07: 4 sign-ups, 3 returning active accounts"});
 fireEvent.focus(point);
 expect(screen.getByText("4 sign-ups · 3 returning active accounts")).toBeTruthy();
 expect(screen.getByRole("button",{name:/2026-10-08.*partial day/})).toBeTruthy();
 expect(screen.getByText(/2026-10-08 is still in progress/)).toBeTruthy();
 expect(fetcher.mock.calls[0][0]).toBe("/api/activity-trend?days=14");
 fireEvent.click(screen.getByText("View daily chart data"));
 expect(screen.getByRole("columnheader",{name:"UTC date"})).toBeTruthy();
 expect(screen.getByText(/independent of the calendar filter/)).toBeTruthy();
});

test("trend refresh hides old counts immediately and ignores a stale response after an access error",async()=>{
 let resolveOld!:(response:Response)=>void;
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{resolveOld=resolve;})).mockResolvedValue(new Response("Denied",{status:403}));
 vi.stubGlobal("fetch",fetcher);
 const view=render(<AdminActivityTrend refresh={0}/>);
 view.rerender(<AdminActivityTrend refresh={1}/>);
 await screen.findByText(/activity trend could not be loaded/);
 resolveOld(Response.json(trend));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 expect(screen.queryByRole("button",{name:/returning active accounts/})).toBeNull();
});

test("rolling presets include today and pages reject account-only pagination fields",()=>{
 expect(presetRange("last-14","2026-03-08")).toMatchObject({start_date:"2026-02-23",end_date:"2026-03-08"});
 expect(parseReportRequest({...range,schema_version:1,kind:"pages"})).not.toBeNull();
 expect(parseReportRequest({...range,schema_version:1,kind:"pages",cursor:"next"})).toBeNull();
 expect(parseReportRequest({...range,schema_version:1,kind:"pages",account_ref:"00000000-0000-4000-8000-000000000001"})).toBeNull();
});
