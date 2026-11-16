# 🚨 Live Incident Commander & Log War Room (`cf_ai_incident_war_room`)

A real-time, stateful AI incident response workspace built on Cloudflare's developer platform. Engineers collaborate in shared incident rooms via live WebSocket chat, push-to-talk voice notes, or raw crash log dumps while an AI Incident Commander tracks hypotheses, executes durable SQLite-checkpointed triage pipelines, and drafts executive post-mortems.

**Live Demo:** `https://cf-ai-incident-war-room.specter-saleem.workers.dev/?room=inc-001`

---

## 🏗️ System Architecture

```mermaid
flowchart TB
    subgraph Client ["Frontend (Cloudflare Workers Assets / Pages)"]
        UI["Split-Pane War Room UI<br/>(Timeline, Hypotheses, Chat & Voice)"]
    end

    subgraph Edge ["Cloudflare Edge Network"]
        Router["Main Worker Router<br/>(src/index.ts)"]
        
        subgraph DO ["Durable Object: IncidentWarRoom (src/war-room-do.ts)"]
            WS["WebSocket Hibernation Hub"]
            SQL[("Built-in SQLite Storage<br/>(timeline, hypotheses & workflow_checkpoints)")]
            
            subgraph Pipeline ["Checkpointed Multi-Step Triage Runner (runStep)"]
                S1["Step 1: Notify Room"]
                S2["Step 2: Structured Extraction<br/>(Exponential Backoff Retries)"]
                S3["Step 3: Commit & Broadcast"]
                S1 --> S2 --> S3
            end
        end

        subgraph AI ["Workers AI"]
            Llama["@cf/meta/llama-3.3-70b-instruct-fp8-fast"]
            Whisper["@cf/openai/whisper"]
        end
    end

    UI <-->|"WSS /ws?room=inc-001"| Router
    UI -->|"POST /api/voice (audio/webm)"| Router
    Router -->|"Upgrade / Forward"| WS
    Router -->|"Transcribe Audio"| Whisper
    Whisper -.->|"Transcript RPC"| WS

    WS <-->|"Persist & Hydrate State"| SQL
    WS <-->|"Conversational Triage"| Llama
    WS -->|"ctx.waitUntil(runLogTriagePipeline)"| S1
    S1 & S2 & S3 <-->|"Checkpoint Step Output"| SQL
    S2 <-->|"JSON Schema Inference"| Llama
    S3 -->|"Broadcast Updated Hypotheses & Status"| WS
