import { DurableObject } from "cloudflare:workers";
import {
  ClientMessage,
  Env,
  Hypothesis,
  TimelineEvent,
} from "./types";

export class IncidentWarRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS timeline (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        author TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_checkpoints (
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        output_json TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, step_name)
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        type: "init",
        timeline: this.getTimeline(),
        hypotheses: this.getHypotheses(),
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer) {
    if (typeof rawMessage !== "string") return;
    const msg: ClientMessage = JSON.parse(rawMessage);

    if (msg.type === "chat") {
      await this.handleChat(msg.text);
    } else if (msg.type === "log_dump") {
      this.appendEvent("user", "log_dump", msg.rawLog.slice(0, 2000));
      const runId = crypto.randomUUID();
      this.ctx.waitUntil(this.runLogTriagePipeline(runId, msg.rawLog));
    } else if (msg.type === "generate_postmortem") {
      const runId = crypto.randomUUID();
      this.ctx.waitUntil(this.runPostMortemPipeline(runId));
    }
  }

  async ingestVoiceTranscript(transcript: string) {
    this.appendEvent("user", "voice_note", `[Voice] ${transcript}`);
    await this.handleChat(transcript, true);
  }

  // --- Durable SQLite-Checkpointed Step Runner with Retries ---
  private async runStep<T>(
    runId: string,
    stepName: string,
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    const cached = this.ctx.storage.sql
      .exec<{ output_json: string }>(
        `SELECT output_json FROM workflow_checkpoints WHERE run_id = ? AND step_name = ?`,
        runId,
        stepName
      )
      .toArray();

    if (cached.length > 0) {
      return JSON.parse(cached[0].output_json) as T;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        this.ctx.storage.sql.exec(
          `INSERT INTO workflow_checkpoints (run_id, step_name, output_json, completed_at)
           VALUES (?, ?, ?, ?)`,
          runId,
          stepName,
          JSON.stringify(result ?? null),
          new Date().toISOString()
        );
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  // --- Multi-Step Pipeline 1: Log Triage & Hypothesis Extraction ---
  private async runLogTriagePipeline(runId: string, rawLog: string) {
    try {
      await this.runStep(runId, "notify-start", async () => {
        this.appendEvent(
          "workflow",
          "status",
          `[Run ${runId.slice(0, 8)}] Step 1/3: Extracting error signatures & stack frames...`
        );
        return true;
      });

      const extracted = await this.runStep(
        runId,
        "extract-hypotheses",
        async () => {
          this.appendEvent(
            "workflow",
            "status",
            `[Run ${runId.slice(0, 8)}] Step 2/3: Running Llama 3.3 root-cause inference...`
          );

          const result = await this.env.AI.run(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            {
              messages: [
                {
                  role: "system",
                  content: `Extract 1 to 3 concrete root-cause hypotheses from the crash/error log.
Respond ONLY with valid JSON matching:
{"hypotheses": [{"id": "hyp-1", "title": "...", "confidence": "high|medium|low", "status": "investigating", "evidence": "..."}]}
Existing hypotheses: ${JSON.stringify(this.getHypotheses())}`,
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

          // Strip accidental markdown fences if model emits them
          const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "").trim();
          return JSON.parse(cleaned) as { hypotheses: Hypothesis[] };
        }
      );

      await this.runStep(runId, "commit-hypotheses", async () => {
        if (extracted.hypotheses?.length) {
          this.upsertHypotheses(extracted.hypotheses);
          this.appendEvent(
            "workflow",
            "status",
            `[Run ${runId.slice(0, 8)}] Step 3/3: Updated ${extracted.hypotheses.length} root-cause hypothesis(es).`
          );
        } else {
          this.appendEvent(
            "workflow",
            "status",
            `[Run ${runId.slice(0, 8)}] Step 3/3: No new hypotheses extracted from log.`
          );
        }
        return true;
      });
    } catch (err) {
      this.appendEvent(
        "workflow",
        "status",
        `[Run ${runId.slice(0, 8)}] Pipeline failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // --- Multi-Step Pipeline 2: Executive Post-Mortem Compilation ---
  private async runPostMortemPipeline(runId: string) {
    try {
      await this.runStep(runId, "notify-postmortem", async () => {
        this.appendEvent(
          "workflow",
          "status",
          `[Run ${runId.slice(0, 8)}] Step 1/2: Compiling executive post-mortem from room timeline...`
        );
        return true;
      });

      const report = await this.runStep(runId, "draft-postmortem", async () => {
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
                content: `Hypotheses:\n${JSON.stringify(
                  this.getHypotheses()
                )}\n\nTimeline:\n${JSON.stringify(this.getTimeline())}`,
              },
            ],
          }
        );
        return typeof res === "object" && "response" in res
          ? (res.response as string)
          : "Failed to generate report.";
      });

      await this.runStep(runId, "publish-postmortem", async () => {
        this.appendEvent("workflow", "postmortem", report);
        return true;
      });
    } catch (err) {
      this.appendEvent(
        "workflow",
        "status",
        `[Run ${runId.slice(0, 8)}] Post-mortem failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async handleChat(userText: string, alreadyLogged = false) {
    if (!alreadyLogged) {
      this.appendEvent("user", "chat", userText);
    }

    const recentHistory = this.getTimeline()
      .slice(-12)
      .map((e) => `[${e.author} | ${e.type}]: ${e.content}`)
      .join("\n");

    const activeHypotheses = JSON.stringify(this.getHypotheses());

    const response = await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          {
            role: "system",
            content: `You are an expert Site Reliability Incident Commander. 
Analyze incoming updates, keep responses concise and actionable, and reference active hypotheses.
Active Hypotheses: ${activeHypotheses}`,
          },
          {
            role: "user",
            content: `Recent War Room Log:\n${recentHistory}\n\nLatest message: ${userText}`,
          },
        ],
      }
    );

    const reply =
      typeof response === "object" && "response" in response
        ? (response.response as string)
        : "Acknowledged.";

    this.appendEvent("commander-ai", "chat", reply);
  }

  private upsertHypotheses(items: Hypothesis[]) {
    for (const h of items) {
      this.ctx.storage.sql.exec(
        `INSERT INTO hypotheses (id, title, confidence, status, evidence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           confidence=excluded.confidence,
           status=excluded.status,
           evidence=excluded.evidence`,
        h.id,
        h.title,
        h.confidence,
        h.status,
        h.evidence
      );
    }
    this.broadcast({
      type: "hypotheses_updated",
      hypotheses: this.getHypotheses(),
    });
  }

  private appendEvent(
    author: TimelineEvent["author"],
    type: TimelineEvent["type"],
    content: string
  ) {
    const event: TimelineEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      author,
      type,
      content,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO timeline (id, timestamp, author, type, content) VALUES (?, ?, ?, ?, ?)`,
      event.id,
      event.timestamp,
      event.author,
      event.type,
      event.content
    );
    this.broadcast({ type: "event", event });
  }

  private getTimeline(): TimelineEvent[] {
    return this.ctx.storage.sql
      .exec<TimelineEvent>(`SELECT * FROM timeline ORDER BY timestamp ASC`)
      .toArray();
  }

  private getHypotheses(): Hypothesis[] {
    return this.ctx.storage.sql
      .exec<Hypothesis>(`SELECT * FROM hypotheses`)
      .toArray();
  }

  private broadcast(payload: unknown) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(msg);
    }
  }
}
