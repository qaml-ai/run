import { createRoot } from "react-dom/client";
import { AgentChat } from "@camelai/agent-runtime-react/ui";
import "@camelai/agent-runtime-react/styles.css";

// Demo sign-in: a random user per browser (see server.ts). Proxied reads send it too.
const user = localStorage.demoUser ??= crypto.randomUUID();

createRoot(document.getElementById("root")!).render(<AgentChat endpoint="/api/agent" headers={{ "x-demo-user": user }} />);
