# cf_ai_study_planner

**Live Demo:** https://cf-ai-study-buddy-5u6.pages.dev/

**cf_ai_study_planner** is an AI-powered academic assistant that helps students overcome "analysis paralysis." Instead of just answering questions, it actively acts as a project manager for your studies—generating schedules, tracking progress, and analyzing work habits over time.

Built entirely on the **Cloudflare Developer Platform**, it combines the speed of an edge-deployed React frontend with a stateful, intelligent backend running on Cloudflare Workers.

## ⚡ Tech Stack

*   **Frontend:** React (Vite) hosted on **Cloudflare Pages**.
*   **Backend/Compute:** **Cloudflare Workers** (ES Modules) for API handling and deterministic routing.
*   **Inference:** **Workers AI** (`@cf/meta/llama-3.1-8b-instruct-fast`) for reasoning and generation.
*   **Persistence:** **Cloudflare KV** for storing user profiles, active study plans, and long-term conversation history.

## 🎯 What It Does

This application goes beyond a standard chatbot by maintaining a persistent "User State" across sessions. It supports four distinct workflows:

### 1. Structured Study Planning
The agent converts vague goals into concrete, bulleted schedules. It accounts for time constraints and existing knowledge.
*   *Input:* "I have a Calculus exam on Friday and I'm bad at derivatives."
*   *Output:* A detailed 3-day breakdown focusing specifically on derivatives, with review blocks scheduled before the exam.

### 2. Adaptive Revision
Plans aren't static. If life gets in the way, the agent can restructure the active plan without forgetting the original goal.
*   *Input:* "I didn't get to study yesterday. Can you adjust the schedule?"
*   *Output:* The remaining tasks are compressed or reprioritized for the remaining days.

### 3. Accountability & Logging
Users report their outcomes directly to the agent. This data is structured and saved to Cloudflare KV, creating a permanent log of performance.
*   *Input:* "I finished the chapter but I'm still confused about Chain Rule."
*   *Output:* The agent logs the session as "Completed with issues" and offers specific tips for the confusing topic.

### 4. Pattern Recognition
Because the agent has access to long-term history (via KV), it can act as a meta-analyst.
*   *Input:* "Why am I not making progress?"
*   *Output:* The agent reviews past logs and might spot trends, e.g., "You consistently skip study sessions scheduled on weekends."

## 📖 How to Use

The interface is a simple chat window, but the backend intelligently routes your messages to specific tools.

**To Start a Plan:**
> "Plan a 2-hour study session for React Hooks."
> "Create a schedule for learning Python in 1 week."

**To Adjust a Plan:**
> "Make it shorter, I only have 30 minutes."
> "Add a break in the middle."

**To Log Progress:**
> "I'm done."
> "I failed to finish the reading."

**To Analyze Habits:**
> "Analyze my study patterns."

## 🏗 Architecture Overview

The application uses a **State-Aware Hybrid Architecture**:

1.  **Frontend:** The React app sends user messages to the Worker via a standard REST API.
2.  **Context Loading:** On every request, the Worker fetches the user's `recentHistory` and `activePlan` from **Cloudflare KV**. This gives the AI "memory" of previous conversations.
3.  **Routing:** A deterministic router classifies the intent (Plan, Log, or Chat). This ensures that requests to "Log a session" don't accidentally trigger a long lecture on history.
4.  **Inference:** The Worker calls **Workers AI** with a system prompt tailored to the specific intent (e.g., specific instructions to be concise during planning).
5.  **Persist:** The AI's response and any changes to the plan are saved back to KV immediately.