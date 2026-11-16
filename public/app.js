const room = new URLSearchParams(location.search).get("room") || "inc-001";
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`);

const timelineEl = document.getElementById("timeline");
const hypothesesEl = document.getElementById("hypotheses");

function renderEvent(ev) {
  const div = document.createElement("div");
  div.className = `event ${ev.author}`;
  div.textContent = `[${new Date(ev.timestamp).toLocaleTimeString()}] ${ev.author.toUpperCase()} (${ev.type}):\n${ev.content}`;
  timelineEl.appendChild(div);
  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function renderHypotheses(list) {
  hypothesesEl.innerHTML = "";
  for (const h of list) {
    const div = document.createElement("div");
    div.className = "hyp-card";
    div.innerHTML = `<strong>${h.title}</strong> <span class="badge">${h.confidence}</span><p style="font-size:13px;color:#8b949e;margin:6px 0 0;">${h.evidence}</p>`;
    hypothesesEl.appendChild(div);
  }
}

ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === "init") {
    timelineEl.innerHTML = "";
    data.timeline.forEach(renderEvent);
    renderHypotheses(data.hypotheses);
  } else if (data.type === "event") {
    renderEvent(data.event);
  } else if (data.type === "hypotheses_updated") {
    renderHypotheses(data.hypotheses);
  }
};

const chatInput = document.getElementById("chatInput");
document.getElementById("sendBtn").onclick = () => {
  if (!chatInput.value.trim()) return;
  ws.send(JSON.stringify({ type: "chat", text: chatInput.value.trim() }));
  chatInput.value = "";
};
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sendBtn").click();
});

document.getElementById("analyzeLogBtn").onclick = () => {
  const logInput = document.getElementById("logInput");
  if (!logInput.value.trim()) return;
  ws.send(JSON.stringify({ type: "log_dump", rawLog: logInput.value.trim() }));
  logInput.value = "";
};

document.getElementById("postmortemBtn").onclick = () => {
  ws.send(JSON.stringify({ type: "generate_postmortem" }));
};

let recorder, chunks = [];
const voiceBtn = document.getElementById("voiceBtn");
voiceBtn.onmousedown = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder = new MediaRecorder(stream);
  chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    await fetch(`/api/voice?room=${encodeURIComponent(room)}`, { method: "POST", body: blob });
  };
  recorder.start();
  voiceBtn.textContent = "🔴 Recording...";
};
voiceBtn.onmouseup = () => {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
    voiceBtn.textContent = "🎙️ Hold to Speak";
  }
};
