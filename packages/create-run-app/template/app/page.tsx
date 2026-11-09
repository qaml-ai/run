import { Chat } from "./components/chat";
import { authorize, configured } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!await configured()) return <main><h1>Configure sign-in</h1><p>Set APP_URL, SESSION_SECRET and GitHub or OIDC credentials. See README.md. Access is closed until authentication is configured.</p></main>;
  if (!await authorize()) return <main><h1>Agent app</h1><a href="/auth/login">Sign in</a></main>;
  return <main><header>Agent app</header><Chat /></main>;
}
