/**
 * Cloudflare Worker: AI Study Planner Agent
 * 
 * ARCHITECTURE OVERVIEW:
 * 1. State Management: Uses Cloudflare KV to store user profiles, long-term session logs, 
 *    and short-term conversation history.
 * 2. Routing Logic: A deterministic router (`chooseAction`) analyzes the user's message 
 *    to decide which "Tool" to use (Plan, Chat, Log, Analyze).
 * 3. AI Execution: Uses `@cf/meta/llama-3.1-8b-instruct-fast`. This model is chosen for 
 *    speed and low latency, which is crucial for a chat interface.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// Standard CORS headers to allow a frontend (likely running on localhost or a different domain)
// to communicate with this worker.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- STATE MANAGEMENT ---

/**
 * Loads the user's state from Cloudflare KV.
 * 
 * DATA STRUCTURE:
 * - profile: Static user preferences (e.g., "weakAreas").
 * - recentHistory: Short-term memory (last few chat turns). Vital for the AI to understand context.
 * - lastSession: The specific plan currently being worked on or discussed.
 * - sessions: Long-term archival of all generated plans (used for pattern analysis).
 */
async function loadStudyState(env, userId) {
  const key = `user:${userId}`;
  const stored = await env.STUDY_STATE_KV.get(key, "json");
  
  const defaults = {
    profile: {
      prefersShortSentences: true,
      weakAreas: [],
    },
    recentHistory: [], 
    lastSession: null, 
    sessions: [], 
    lastAnalysis: null,
  };

  if (!stored) return defaults;

  // Merge stored data with defaults to ensure all arrays exist 
  // (prevents crashes if the schema changes later).
  return {
    ...defaults,
    ...stored,
    recentHistory: Array.isArray(stored.recentHistory) ? stored.recentHistory : [],
    sessions: Array.isArray(stored.sessions) ? stored.sessions : [],
  };
}

/**
 * Saves state back to KV.
 * 
 * OPTIMIZATION:
 * We slice `recentHistory` to the last 8 messages. 
 * - Prevents the Context Window from overflowing (LLMs have limits).
 * - Reduces KV storage costs.
 * - Keeps the AI focused on the *immediate* conversation rather than old topics.
 */
async function saveStudyState(env, userId, state) {
  const key = `user:${userId}`;
  
  if (state.recentHistory.length > 8) {
    state.recentHistory = state.recentHistory.slice(-8);
  }
  await env.STUDY_STATE_KV.put(key, JSON.stringify(state));
}

// --- HELPERS ---

/**
 * Converts the array of message objects into a single string for the System Prompt.
 * LLMs read text, not JSON objects, so this formatting is crucial for them 
 * to understand "Who said what".
 */
function formatHistory(history) {
  if (!history || history.length === 0) return "";
  return history
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");
}

/**
 * Heuristic to detect if the user wants a factual answer ("How do pointers work?")
 * vs a planning action ("Plan my day").
 * 
 * LOGIC:
 * - Must end in a question mark.
 * - Must NOT contain planning keywords (schedule, block).
 * - Must NOT contain self-referential pronouns (I, me, my), as those usually imply personalized advice.
 */
function isDirectQuestion(message) {
  if (!message) return false;
  const trimmed = message.trim();
  if (/\b(plan|schedule|session|block)\b/i.test(trimmed)) return false;
  return /[?？！]$/.test(trimmed) && !/\b(we|I|me|my)\b/i.test(trimmed);
}

// --- ROUTING ---

/**
 * The "Brain" of the agent. It classifies the user's intent to select the right AI prompt.
 * 
 * PRIORITY ORDER:
 * 1. Analysis (meta-discussion about habits).
 * 2. Logging outcomes (reporting on a past session).
 * 3. Creating/Revising plans (explicit keywords).
 * 4. Contextual Agreement (User says "ok" -> implies continuing current flow).
 * 5. General Chat (Fallback / Clarification).
 */
function chooseAction(state, message) {
  const text = (message || "").toLowerCase();
  
  // 1. Analyze Patterns
  if (/\b(analy[sz]e|pattern|habit|trend|history)\b/.test(text)) {
    return "analyze_pattern";
  }

  // 2. Log Outcome
  // We only check this if `state.lastSession` exists, because you can't "finish" a plan that doesn't exist.
  if (
    /\b(finished|completed|done|did it|failed|stuck|fell behind)\b/.test(text) &&
    state.lastSession
  ) {
    return "log_outcome";
  }

  // 3. Planning Triggers (Explicit keywords)
  if (/\b(plan|schedule|agenda|block|timetable|routine)\b/.test(text)) {
    // If a session already exists, we assume they want to REVISE it, otherwise CREATE new.
    return state.lastSession ? "revise_plan" : "create_plan";
  }

  // 4. Revision Triggers (Explicit change requests)
  if (
    /\b(change|adjust|revise|modify|tweak|shorter|longer)\b/.test(text) &&
    state.lastSession
  ) {
    return "revise_plan";
  }

  // 5. Implicit "Let's do it" (Contextual Agreement)
  // PROBLEM SOLVED: Previously, if the user said "ok", the bot treated it as a greeting.
  // NOW: We route this to `general_chat`, but the prompt there knows to look at history 
  // to see what we are agreeing to.
  if (/^(ok|okay|sure|fine|yes|go ahead|do it)$/.test(text)) {
    return "general_chat";
  }

  // 6. Direct Study Intent
  // If they say "I want to study X", we default to creating a plan.
  if (/\b(study|learn|review|prep|prepare)\b/.test(text)) {
    return "create_plan"; 
  }

  // 7. Direct Factual Question
  // Uses the helper to detect "What is a pointer?" vs "How do I study pointers?"
  if (isDirectQuestion(message)) {
    return "direct_answer";
  }

  // 8. Fallback
  // Handles greetings ("Hi"), vague complaints ("I'm tired"), or clarifying questions.
  return "general_chat";
}

// --- HANDLERS ---

/**
 * Handler: General Chat
 * PURPOSE: Acts as a buffer/bridge. It builds context before locking in a structured plan.
 * 
 * PROMPT STRATEGY:
 * - It sees `recentHistory` so it knows what was just said.
 * - Instructions explicitly tell it to "Move towards a plan". 
 * - Prevents the bot from becoming a passive listener.
 */
async function handleGeneralChat(state, message, env) {
  const historyStr = formatHistory(state.recentHistory);
  
  const systemPrompt = `
You are a study strategy consultant.

CONTEXT (Last few messages):
${historyStr}

CURRENT USER MESSAGE: "${message}"

YOUR GOAL:
- Move the conversation towards creating a concrete study plan.
- Do NOT get stuck in small talk loops.
- If the user has identified a topic (like "C programming" or "Exam"), propose a specific next step.
- If the user answers "ok" or "sure", interpret that as agreement to your previous suggestion.

EXAMPLES:
- History includes "I want to learn C". User says "I know Python". You say: "Great. Since you know Python, we can skip basic loops and focus on Pointers. Shall I create a 1-week schedule?"
`;

  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    // 500 tokens is enough for a conversational reply, but prevents rambling.
    max_tokens: 500, 
  });

  const reply = aiResult?.result || aiResult?.response || "How can I help you study today?";
  return { reply, newState: state };
}

/**
 * Handler: Direct Answer
 * PURPOSE: Answer factual questions without messing up the planning state.
 * No state changes occur here.
 */
async function answerDirectQuestion(state, message, env) {
  const systemPrompt = `Answer the user's factual question directly and concisely (max 3 sentences). Do not offer a plan.`;
  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    max_tokens: 300, 
  });
  return { reply: aiResult?.result || aiResult?.response || "I don't know.", newState: state };
}

/**
 * Handler: Create Plan
 * PURPOSE: The core value proposition. Generates a structured study schedule.
 * 
 * KEY FIX: `max_tokens: 2048`.
 * Previously, detailed plans were getting cut off mid-sentence because the default
 * token limit is usually 256. We increased this significantly to allow for
 * bulleted lists and multi-week breakdowns.
 */
async function createPlan(state, message, env) {
  const historyStr = formatHistory(state.recentHistory);

  const systemPrompt = `
You are a study planner. Create a concrete, bulleted study block plan.

CONTEXT (Recent Chat - Use this for topic/constraints):
${historyStr}

USER REQUEST: "${message}"

RULES:
1. Infer the topic from the chat history if not explicitly stated in this specific message.
2. If the user mentions a long timeframe (e.g., "1 month"), provide a high-level breakdown AND a detailed plan for the *first* session.
3. Be specific (e.g., "Read Chapter 1", "Practice 3 exercises").
4. No fluff.
`;

  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    max_tokens: 2048, // Critical for avoiding response cutoff
  });

  const planText = aiResult?.result || aiResult?.response || "Could not generate plan.";

  // Store the plan in `lastSession` (the active goal) AND append to `sessions` (log).
  const session = {
    id: String(Date.now()),
    timestamp: Date.now(),
    goal: message,
    action: "create_plan",
    plan: planText,
    outcomeNote: null,
  };

  const sessions = [...state.sessions, session];

  return { 
    reply: planText, 
    newState: { ...state, lastSession: session, sessions } 
  };
}

/**
 * Handler: Revise Plan
 * PURPOSE: Takes the existing plan (from state) and modifies it based on user feedback.
 */
async function revisePlan(state, message, env) {
  const lastPlan = state.lastSession ? state.lastSession.plan : "No active plan.";
  const systemPrompt = `
Revise this study plan based on user feedback.
Old Plan: ${lastPlan}
Feedback: ${message}
Output: A new bulleted plan.
`;
  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    max_tokens: 2048, 
  });
  const newPlan = aiResult?.result || aiResult?.response || "Could not revise plan.";
  
  // Update the existing session plan rather than creating a brand new log entry,
  // though we do save it to history.
  const session = {
    ...state.lastSession,
    id: String(Date.now()),
    timestamp: Date.now(),
    action: "revise_plan",
    plan: newPlan,
  };

  return { 
    reply: newPlan, 
    newState: { ...state, lastSession: session, sessions: [...state.sessions, session] } 
  };
}

/**
 * Handler: Log Outcome
 * PURPOSE: Allows the user to say "I finished" or "I failed".
 * The AI gives feedback/tips based on the result.
 */
async function logOutcome(state, message, env) {
  const lastPlan = state.lastSession ? state.lastSession.plan : "(No plan)";
  const systemPrompt = `
User reported outcome for plan:
${lastPlan}
User Report: ${message}
Task: Give 1 sentence of feedback and 1 specific tip for next time.
`;
  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    max_tokens: 300,
  });
  const reply = aiResult?.result || aiResult?.response || "Logged.";
  
  // We update the specific session in the history with the outcome note.
  const sessions = [...state.sessions];
  if (sessions.length > 0) {
    sessions[sessions.length - 1].outcomeNote = message;
  }

  return { reply, newState: { ...state, lastSession: { ...state.lastSession, outcomeNote: message }, sessions } };
}

/**
 * Handler: Analyze Pattern
 * PURPOSE: Looks at the `sessions` array (long-term memory) to find trends.
 * e.g., "You always study late at night."
 */
async function analyzePattern(state, message, env) {
  const sessions = state.sessions || [];
  // We only send the last 10 sessions to keep the context size reasonable.
  const systemPrompt = `
Analyze these study sessions: ${JSON.stringify(sessions.slice(-10))}
User Question: ${message}
Output: 2 trends and 1 suggestion. Max 100 words.
`;
  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Analyze my patterns" },
    ],
    max_tokens: 500,
  });
  return { reply: aiResult?.result || aiResult?.response || "No data.", newState: { ...state, lastAnalysis: aiResult?.result } };
}

// --- MAIN ---

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle Preflight CORS requests (browser security requirement)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check (useful for monitoring uptime)
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // Debugging Route: View current state in JSON format
    if (url.pathname === "/debug/state") {
      const userId = "demo-user";
      const state = await loadStudyState(env, userId);
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // Debugging Route: Wipe state clean to start over
    if (url.pathname === "/debug/reset") {
      const userId = "demo-user";
      await saveStudyState(env, userId, {
        recentHistory: [],
        sessions: [],
        lastSession: null,
      });
      return new Response(JSON.stringify({ reset: true }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // --- CHAT ENDPOINT (The main interaction) ---

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const { message } = await request.json();
      const userId = "demo-user"; // Hardcoded for this demo; normally pulled from auth token

      // 1. Load context
      let state = await loadStudyState(env, userId);
      
      // 2. Decide what to do
      const action = chooseAction(state, message);

      // 3. Execute logic
      let outcome;
      if (action === "direct_answer") outcome = await answerDirectQuestion(state, message, env);
      else if (action === "create_plan") outcome = await createPlan(state, message, env);
      else if (action === "revise_plan") outcome = await revisePlan(state, message, env);
      else if (action === "log_outcome") outcome = await logOutcome(state, message, env);
      else if (action === "analyze_pattern") outcome = await analyzePattern(state, message, env);
      else outcome = await handleGeneralChat(state, message, env);

      // 4. Append interaction to recent history (Short-term memory)
      const updatedHistory = [
        ...state.recentHistory,
        { role: "user", content: message },
        { role: "assistant", content: outcome.reply }
      ];

      // 5. Save updated state to KV
      const finalState = {
        ...outcome.newState,
        recentHistory: updatedHistory
      };

      // Save updated state to KV
      // We wrap the Promise in ctx.waitUntil(). 
      // This tells Cloudflare: "Send the response NOW, but keep the worker alive 
      // until this save finishes in the background."
      ctx.waitUntil(saveStudyState(env, userId, finalState));

      // 6. Return response to frontend
      // The user gets this immediately!
      return new Response(JSON.stringify({ reply: outcome.reply, action }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};
