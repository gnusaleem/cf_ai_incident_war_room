import { DurableObject } from "cloudflare:workers";
import { ClientMessage, Env, Hypothesis, TimelineEvent } from "./types";

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
      await this.handleLogDump(msg.rawLog);
    } else if (msg.type === "generate_postmortem") {
      await this.env.TRIAGE_WORKFLOW.create({
        params: {
          roomName: this.ctx.id.name || "inc-default",
          mode: "postmortem",
          timeline: this.getTimeline(),
          hypotheses: this.getHypotheses(),
        },
      });
    }
  }

  async ingestVoiceTranscript(transcript: string) {
    this.appendEvent("user", "voice_note", `[Voice] ${transcript}`);
    await this.handleChat(transcript, true);
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

  private async handleLogDump(rawLog: string) {
    this.appendEvent("user", "log_dump", rawLog.slice(0, 2000));

    await this.env.TRIAGE_WORKFLOW.create({
      params: {
        roomName: this.ctx.id.name || "inc-default",
        mode: "analyze_logs",
        rawLog,
        existingHypotheses: this.getHypotheses(),
      },
    });
  }

  async pushWorkflowUpdate(
    statusText: string,
    type: TimelineEvent["type"] = "status"
  ) {
    this.appendEvent("workflow", type, statusText);
  }

  async upsertHypotheses(items: Hypothesis[]) {
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
