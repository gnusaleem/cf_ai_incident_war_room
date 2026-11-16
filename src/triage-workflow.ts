import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { Env, Hypothesis, TimelineEvent } from "./types";

type TriageParams =
  | {
      roomName: string;
      mode: "analyze_logs";
      rawLog: string;
      existingHypotheses: Hypothesis[];
    }
  | {
      roomName: string;
      mode: "postmortem";
      timeline: TimelineEvent[];
      hypotheses: Hypothesis[];
    };

export class IncidentTriageWorkflow extends WorkflowEntrypoint<
  Env,
  TriageParams
> {
  async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep) {
    const { roomName, mode } = event.payload;
    const roomStub = this.env.WAR_ROOM.get(
      this.env.WAR_ROOM.idFromName(roomName)
    );

    if (mode === "analyze_logs") {
      const { rawLog, existingHypotheses } = event.payload;

      await step.do("notify-start", async () => {
        await roomStub.pushWorkflowUpdate(
          "Workflow started: Extracting error signatures & stack frames..."
        );
      });

      const extracted = await step.do(
        "extract-hypotheses",
        { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } },
        async () => {
          const result = await this.env.AI.run(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            {
              messages: [
                {
                  role: "system",
                  content: `Extract 1 to 3 concrete root-cause hypotheses from the crash/error log.
Respond ONLY with valid JSON matching:
{"hypotheses": [{"id": "hyp-1", "title": "...", "confidence": "high|medium|low", "status": "investigating", "evidence": "..."}]}
Existing hypotheses: ${JSON.stringify(existingHypotheses)}`,
                },
                { role: "user", content: rawLog.slice(0, 12000) },
              ],
              response_format: { type: "json_object" },
            }
          );

          const rawText =
            typeof result === "object" && "response" in result
              ? (result.response as string)
              : '{"hypotheses":[]}';
          return JSON.parse(rawText) as { hypotheses: Hypothesis[] };
        }
      );

      await step.do("commit-hypotheses", async () => {
        if (extracted.hypotheses?.length) {
          await roomStub.upsertHypotheses(extracted.hypotheses);
          await roomStub.pushWorkflowUpdate(
            `Updated ${extracted.hypotheses.length} root-cause hypothesis(es) from log analysis.`
          );
        }
      });
    }

    if (mode === "postmortem") {
      const { timeline, hypotheses } = event.payload;

      await step.do("notify-postmortem", async () => {
        await roomStub.pushWorkflowUpdate(
          "Compiling executive post-mortem report from room timeline..."
        );
      });

      const report = await step.do("draft-postmortem", async () => {
        const res = await this.env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "Write a crisp Markdown Incident Post-Mortem with: Summary, Root Cause, Timeline of Key Events, and Action Items.",
              },
              {
                role: "user",
                content: `Hypotheses:\n${JSON.stringify(hypotheses)}\n\nTimeline:\n${JSON.stringify(timeline)}`,
              },
            ],
          }
        );
        return typeof res === "object" && "response" in res
          ? (res.response as string)
          : "Failed to generate report.";
      });

      await step.do("publish-postmortem", async () => {
        await roomStub.pushWorkflowUpdate(report, "postmortem");
      });
    }
  }
}
