import { useEffect, useState } from "react";
import { sendChat, fetchState, resetState, healthCheck } from "./api";
import "./index.css";

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString();
}

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [backendState, setBackendState] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await healthCheck();
        setHealth(h);
      } catch {
        setHealth({ ok: false });
      }
      try {
        const st = await fetchState();
        setBackendState(st);
      } catch {
        // ignore on boot
      }
    })();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    setError(null);
    setInput("");

    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);

    try {
      const res = await sendChat(text);
      const { reply, action } = res;

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: reply || "(no reply)",
          action: action || "unknown",
        },
      ]);

      const st = await fetchState();
      setBackendState(st);
    } catch (e) {
      setError(e.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    try {
      await resetState();
      const st = await fetchState();
      setBackendState(st);
      setMessages([]);
      setError(null);
    } catch (e) {
      setError("Failed to reset state: " + e.message);
    }
  }

  const lastSession = backendState?.lastSession || null;
  const sessions = backendState?.sessions || [];
  const lastAnalysis = backendState?.lastAnalysis || null;

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>Study Agent on Cloudflare</h1>
          <p className="subtitle">
            LLM + KV + agentic routing. 
          </p>
        </div>
        <div className="header-controls">
          <button onClick={handleReset} className="secondary">
            Reset demo state
          </button>
          <span className={`health-pill ${health?.ok ? "ok" : "bad"}`}>
            {health?.ok ? "Backend: OK" : "Backend: unreachable"}
          </span>
        </div>
      </header>

      <main className="layout">
        {/* Chat */}
        <section className="panel chat-panel">
          <h2>Chat</h2>
          <div className="chat-window">
            {messages.length === 0 && (
              <div className="empty-hint">
                Start by telling the agent what you need to study and how much time you have.
              </div>
            )}
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`chat-message ${m.role === "user" ? "user" : "assistant"}`}
              >
                <div className="chat-meta">
                  <span className="role-label">
                    {m.role === "user" ? "You" : "Agent"}
                  </span>
                  {m.role === "assistant" && m.action && (
                    <span className="action-label">{m.action}</span>
                  )}
                </div>
                <div className="chat-text">{m.text}</div>
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Example: I have 75 minutes to study Cloudflare Durable Objects."
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button onClick={handleSend} disabled={loading || !input.trim()}>
              {loading ? "Thinking..." : "Send"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </section>

        {/* State visualization */}
        <section className="panel state-panel">
          <div className="state-block">
            <h2>Current Plan</h2>
            {lastSession && lastSession.plan ? (
              <>
                <div className="state-meta">
                  <div>
                    <strong>Goal:</strong> {lastSession.goal}
                  </div>
                  <div>
                    <strong>Last updated:</strong>{" "}
                    {formatTimestamp(lastSession.timestamp)}
                  </div>
                </div>
                <pre className="plan-text">{lastSession.plan}</pre>
                {lastSession.outcomeNote && (
                  <div className="note">
                    <strong>Last outcome:</strong> {lastSession.outcomeNote}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-hint">
                No active plan yet. Ask for one in the chat.
              </div>
            )}
          </div>

          <div className="state-block">
            <h2>Study History</h2>
            {sessions.length === 0 ? (
              <div className="empty-hint">No sessions recorded yet.</div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Goal</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions
                      .slice()
                      .reverse()
                      .map((s) => (
                        <tr key={s.id}>
                          <td>{formatTimestamp(s.timestamp)}</td>
                          <td>
                            <code>{s.action}</code>
                          </td>
                          <td className="goal-cell">{s.goal}</td>
                          <td className="outcome-cell">
                            {s.outcomeNote || "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="state-block">
            <h2>Habit Analysis</h2>
            {lastAnalysis ? (
              <pre className="analysis-text">{lastAnalysis}</pre>
            ) : (
              <div className="empty-hint">
                Ask the agent: “Analyze my study patterns so far.”
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span>
          Backend: Cloudflare Workers + Workers AI + KV · Agent routing via LLM.
        </span>
      </footer>
    </div>
  );
}

export default App;
