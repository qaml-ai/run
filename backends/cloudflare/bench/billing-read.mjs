// Read account usage, without exposing billing profile or payment information.
import {writeFile} from 'node:fs/promises';
const account = '85bbd288051330fb51ee1c86031a299b';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Missing Cloudflare credential');
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/billing/usage?metrics=workersRequests&since=2026-11-04T19%3A30%3A00Z&until=${encodeURIComponent(new Date().toISOString())}&time_delta=hour&limit=2`, {headers:{Authorization:`Bearer ${token}`}});
const body = await response.json();
const result = {at:new Date().toISOString(),status:response.status,success:body.success,errors:body.errors,usage:body.result};
await writeFile(new URL('./.state/billing-read.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
