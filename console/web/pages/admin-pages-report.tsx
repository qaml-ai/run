import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PagesReport } from "@/lib/admin-report-types";
const number=(n:number)=>new Intl.NumberFormat("en-US").format(n);
const rate=(converted:number,total:number)=>total?new Intl.NumberFormat("en-US",{style:"percent",maximumFractionDigits:1}).format(converted/total):"—";

export function AdminPagesReport({report}:{report:PagesReport}) {
  const [sort,setSort]=useState("visitors");
  const totals=report.totals, attribution=report.signup_attribution;
  const rows=[...report.pages].sort((a,b)=>sort==="signups"?b.signups-a.signups:sort==="conversion"?(b.new_visitors?b.new_visitor_signups/b.new_visitors:-1)-(a.new_visitors?a.new_visitor_signups/a.new_visitors:-1):sort==="visitors"?b.visitors-a.visitors:0);
  return <>
    <div className="metric-grid page-metrics">{[
      {label:"Recorded visitors",value:number(totals.visitors),detail:"Distinct browsers across Run pages"},
      {label:"Browsers clicking to Run",value:number(totals.run_click_visitors),detail:`${number(totals.run_clicks)} clicks during selected dates`},
      {label:"First-touch sign-ups",value:number(totals.signups),detail:"Signed up during selected dates"},
      {label:"New-visitor conversion",value:rate(totals.new_visitor_signups,totals.new_visitors),detail:`${number(totals.new_visitor_signups)} of ${number(totals.new_visitors)} new browsers signed up to date`},
    ].map(item=><article className="metric" key={item.label}><h2>{item.label}</h2><strong className="metric-value">{item.value}</strong><p>{item.detail}</p></article>)}</div>
    <section className="panel" aria-label="Run page performance">
      <div className="panel-heading"><h2>Run page performance</h2><label className="page-sort">Sort by <select aria-label="Sort Run pages" value={sort} onChange={event=>setSort(event.target.value)}><option value="visitors">Visitors</option><option value="signups">Attributed sign-ups</option><option value="conversion">New-visitor conversion</option><option value="published">Site pages, then newest posts</option></select></label></div>
      {!totals.page_views&&<p className="coverage-note">No page views were recorded for these pages during the selected dates. This does not prove there were no visitors.</p>}
      <Table className="pages-table"><TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Visitors</TableHead><TableHead>Page views</TableHead><TableHead>Clicks to Run</TableHead><TableHead>Sign-ups<small className="cell-meta">First touch</small></TableHead><TableHead>Activated<small className="cell-meta">To date</small></TableHead><TableHead>Paying<small className="cell-meta">To date</small></TableHead><TableHead>Conversion<small className="cell-meta">To date</small></TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(row=><TableRow key={row.page_path}><TableCell className="page-name"><a href={row.page_url} target="_blank" rel="noreferrer">{row.title}</a><span className="cell-meta">{row.page_url.replace(/^https?:\/\//, "")}</span>{row.published_on&&row.published_on>report.generated_at.slice(0,10)&&<span className="cell-meta">Scheduled · {row.published_on}</span>}</TableCell><TableCell data-label="Visitors">{number(row.visitors)}</TableCell><TableCell data-label="Page views">{number(row.page_views)}</TableCell><TableCell data-label="Clicks to Run">{number(row.run_clicks)}<span className="cell-meta">{number(row.run_click_visitors)} browsers</span></TableCell><TableCell data-label="First-touch sign-ups">{number(row.signups)}</TableCell><TableCell data-label="Activated to date">{number(row.signups_activated)}</TableCell><TableCell data-label="Paying to date">{number(row.signups_paying)}</TableCell><TableCell data-label="New-visitor conversion">{rate(row.new_visitor_signups,row.new_visitors)}<span className="cell-meta">{number(row.new_visitor_signups)} / {number(row.new_visitors)} new browsers</span></TableCell></TableRow>)}</TableBody></Table>
    </section>
    <section className="attribution-summary" aria-label="Signup attribution coverage"><h3>Where this period’s tracked sign-ups first landed</h3><p><strong>{number(attribution.run_pages)}</strong> on Run pages · <strong>{number(attribution.other_pages)}</strong> on other pages · <strong>{number(attribution.not_captured)}</strong> not captured · <strong>{number(attribution.total)}</strong> tracked sign-ups total</p></section>
    <details className="page-method"><summary>How to read these metrics</summary><ul>
      <li>Visitors are recorded anonymous browser IDs, not verified people. Multiple devices count separately; browsers that refuse tracking are absent. Bots that execute the site script may be included. Staff browsers are excluded once identified.</li>
      <li>Visitors, views and Run clicks occurred during the selected dates. The total visitor count deduplicates browsers across pages, so individual rows may add up to more.</li>
      <li>First-touch sign-ups happened during the selected dates, but their first landing may have happened earlier. Activated and paying columns describe those sign-ups’ recorded outcomes to date. Dividing these sign-ups by this period’s visitors is not a conversion rate.</li>
      <li>New-visitor conversion follows browsers whose first recorded visit fell within the selected dates and started on that page. It shows how many have signed up by this report. Recent periods have had less time to convert. A dash means no eligible new visitors.</li>
      <li>The page list includes the homepage, /run and an editorial list of Run-related blog posts, including scheduled posts. A zero means no matching tracked events, not proof of no traffic. Attribution totals cover the tracking store and can differ from all sign-ups in Run’s database.</li>
    </ul></details>
  </>;
}
