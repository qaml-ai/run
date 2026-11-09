/** Computer choice on delegate and spawn_agent: share when the parent has one, none otherwise. */
export type ComputerChoice = "share" | "fork" | "fresh" | "none";
export interface ChildTask {
  agent?: string;
  instructions?: string;
  task: string;
  name?: string;
  computer?: ComputerChoice;
  output?: Record<string, unknown>;
}

