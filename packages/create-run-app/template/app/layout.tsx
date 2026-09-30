import type { ReactNode } from "react";
import "@camelai/run-react/styles.css";
import "./globals.css";

export const metadata = { title: "Agent app", description: "A chat with an agent on camelRun" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
