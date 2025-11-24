const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";


async function loadStudyState(env, userId) {
	const key = `user:${userId}`;
	const stored = await env.STUDY_STATE_KV.get(key, "json");
	if (stored) {
		// Ensure newer fields exist
		return {
			profile: stored.profile || {
				prefersShortSentences: true,
				weakAreas: [],
			},
			lastSession: stored.lastSession || null,
			sessions: Array.isArray(stored.sessions) ? stored.sessions : [],
			lastAnalysis: stored.lastAnalysis || null,
		};
	}

	// default state if nothing is stored yet
	return {
		profile: {
			prefersShortSentences: true,
			weakAreas: [],
		},
		lastSession: null,
		sessions: [],
		lastAnalysis: null,
	};
}

async function saveStudyState(env, userId, state) {
	const key = `user:${userId}`;
	await env.STUDY_STATE_KV.put(key, JSON.stringify(state));
}

async function createPlan(state, message, env) {
	const systemPrompt = `
    You are a study planner.

    User profile:
    ${JSON.stringify(state.profile)}

    Last session (may be null):
    ${JSON.stringify(state.lastSession)}

    The user will describe what they need to study and time.
    Create a concrete plan for the next 60–90 minutes only, in bullet points.
  `;

	const aiResult = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: message },
		],
	});

	const planText =
		aiResult?.result || aiResult?.response || "Could not generate plan.";

	const session = {
		id: String(Date.now()),
		timestamp: Date.now(),
		goal: message,
		action: "create_plan",
		plan: planText,
		outcomeNote: null,
	};

	const sessions = Array.isArray(state.sessions) ? state.sessions.slice() : [];
	sessions.push(session);

	const newState = {
		...state,
		lastSession: session,
		sessions,
	};

	return { reply: planText, newState };
}

async function revisePlan(state, message, env) {
	const lastPlan = state.lastSession ? state.lastSession.plan : "(none)";
	const goal =
		(state.lastSession && state.lastSession.goal) || message || "(unspecified goal)";

	const systemPrompt = `
    You are revising an existing study plan.

    Existing plan:
    ${lastPlan}

    The user will describe what didn't work or what changed.
    Adjust the plan to fit the new constraints, keeping it realistic and concrete.
  `;

	const aiResult = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: message },
		],
	});

	const newPlan =
		aiResult?.result || aiResult?.response || "Could not revise plan.";

	const session = {
		id: String(Date.now()),
		timestamp: Date.now(),
		goal,
		action: "revise_plan",
		plan: newPlan,
		outcomeNote: null,
	};

	const sessions = Array.isArray(state.sessions) ? state.sessions.slice() : [];
	sessions.push(session);

	const newState = {
		...state,
		lastSession: session,
		sessions,
	};

	return { reply: newPlan, newState };
}

async function logOutcome(state, message, env) {
	const lastPlan = state.lastSession ? state.lastSession.plan : "(none)";

	const systemPrompt = `
    The user is reporting how their last study session went.
    Last plan:
    ${lastPlan}

    Summarize what worked and what didn't, and give one concrete suggestion for next time.
    Be concise.
  `;

	const aiResult = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: message },
		],
	});

	const reply =
		aiResult?.result || aiResult?.response || "Thanks for the update.";

	// Update sessions: attach outcomeNote to the latest session if present
	const sessions = Array.isArray(state.sessions) ? state.sessions.slice() : [];
	if (sessions.length > 0) {
		const lastIndex = sessions.length - 1;
		sessions[lastIndex] = {
			...sessions[lastIndex],
			outcomeNote: message,
		};
	} else {
		// No previous sessions; create a standalone log entry
		sessions.push({
			id: String(Date.now()),
			timestamp: Date.now(),
			goal: state.lastSession?.goal || "(unknown goal)",
			action: "log_outcome",
			plan: state.lastSession?.plan || null,
			outcomeNote: message,
		});
	}

	const newLastSession = state.lastSession
		? { ...state.lastSession, outcomeNote: message }
		: state.lastSession;

	const newState = {
		...state,
		lastSession: newLastSession,
		sessions,
	};

	return { reply, newState };
}

async function analyzePattern(state, message, env) {
	const sessions = Array.isArray(state.sessions) ? state.sessions : [];

	const systemPrompt = `
    You are analyzing a student's study sessions.

    Study history (JSON):
    ${JSON.stringify(sessions)}

    The user may add a comment or question:
    ${message || "(no additional comment)"}

    Identify 2–3 patterns in their behavior:
    - what kinds of goals or topics recur
    - where they tend to get stuck or cut sessions short
    - any timing or energy patterns you can infer

    Then give 1–2 concrete, practical suggestions for adjusting future study plans.
    Be concise and specific.
  `;

	const aiResult = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: "Please analyze my study patterns." },
		],
	});

	const summary =
		aiResult?.result || aiResult?.response || "No clear patterns found yet.";

	const newState = {
		...state,
		lastAnalysis: summary,
	};

	return { reply: summary, newState };
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/debug/reset") {
			const userId = "demo-user";
			await saveStudyState(env, userId, {
				profile: {
					prefersShortSentences: true,
					weakAreas: [],
				},
				lastSession: null,
				sessions: [],
				lastAnalysis: null,
			});
			return new Response(JSON.stringify({ reset: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Health check (optional)
		if (url.pathname === "/api/health") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Debug: inspect stored state
		if (url.pathname === "/debug/state") {
			const userId = "demo-user";
			const state = await loadStudyState(env, userId);
			return new Response(JSON.stringify(state), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			const { message } = await request.json();

			const userId = "demo-user";

			// 1) Load state from KV
			const state = await loadStudyState(env, userId);

			// 2) Router: decide which action to use
			const routerPrompt = `
    You are a router for a study assistant.

    You must choose exactly one of these actions:
    - "create_plan": user is starting a new study block or there is no valid existing plan.
    - "revise_plan": user says the plan didn't work, needs adjustment, or time changed.
    - "log_outcome": user is reporting how a session went, not asking for a new plan.
    - "analyze_pattern": user is asking you to review their history, habits, or patterns,
      or asking what you notice about how they study across sessions.

    Current state:
    ${JSON.stringify(state)}

    User message:
    ${message}

    Respond with a JSON object only, no extra text, like:
    {"action":"create_plan"}
  `;

			const routerResult = await env.AI.run(MODEL, {
				messages: [
					{ role: "system", content: routerPrompt },
					{ role: "user", content: message },
				],
			});

			const routerText =
				routerResult?.result ||
				routerResult?.response ||
				'{"action":"create_plan"}';

			let action = "create_plan";
			try {
				const parsed = JSON.parse(routerText);
				if (parsed && typeof parsed.action === "string") {
					action = parsed.action;
				}
			} catch (e) {
				// fallback to create_plan
			}

			// 3) Execute chosen action
			let outcome;
			if (action === "revise_plan") {
				outcome = await revisePlan(state, message, env);
			} else if (action === "log_outcome") {
				outcome = await logOutcome(state, message, env);
			} else if (action === "analyze_pattern") {
				outcome = await analyzePattern(state, message, env);
			} else {
				outcome = await createPlan(state, message, env);
			}

			// 4) Save updated state
			await saveStudyState(env, userId, outcome.newState);

			// 5) Return reply and action (for debugging)
			return new Response(JSON.stringify({ reply: outcome.reply, action }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Default response
		return new Response("error");
	},
};
