export function inlinePrompt(name: string): string;
export function auditCommand(options: { branch: string; vaultName: string; vaultUrl: string; blocked: string }): string;
export function verifyPilot(values: Record<string, string | undefined>, options?: {
  transport?: typeof fetch;
  key?: string;
  pause?: (ms: number) => Promise<void>;
}): Promise<{ checks: { role: string; clonePush: boolean; vaultSubstitution: boolean; blockedHost403: boolean }[]; seconds: number }>;
