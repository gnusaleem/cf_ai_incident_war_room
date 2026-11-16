export interface Env {
  AI: Ai;
  WAR_ROOM: DurableObjectNamespace<import("./war-room-do").IncidentWarRoom>;
}

export type Hypothesis = {
  id: string;
  title: string;
  confidence: "high" | "medium" | "low";
  status: "investigating" | "confirmed" | "ruled_out";
  evidence: string;
};

export type TimelineEvent = {
  id: string;
  timestamp: string;
  author: "user" | "commander-ai" | "workflow";
  type: "chat" | "log_dump" | "voice_note" | "status" | "postmortem";
  content: string;
};

export type WorkflowRunRecord = {
  run_id: string;
  mode: "analyze_logs" | "postmortem";
  step_name: string;
  status: "running" | "completed" | "failed";
  updated_at: string;
};

export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "log_dump"; rawLog: string }
  | { type: "generate_postmortem" };
