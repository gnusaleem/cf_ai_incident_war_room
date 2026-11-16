import { Env } from "./types";
export { IncidentWarRoom } from "./war-room-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room") || "inc-default";
    const id = env.WAR_ROOM.idFromName(roomId);
    const roomStub = env.WAR_ROOM.get(id);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return roomStub.fetch(request);
    }

    if (url.pathname === "/api/voice" && request.method === "POST") {
      const audioBuffer = await request.arrayBuffer();
      const transcription = await env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(audioBuffer)],
      });

      const text = transcription.text?.trim();
      if (text) {
        await roomStub.ingestVoiceTranscript(text);
      }
      return Response.json({ transcript: text });
    }

    return new Response("Not Found", { status: 404 });
  },
};
