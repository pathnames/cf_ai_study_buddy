/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
async function loadStudyState(env, userId) {
	const key = `user:${userId}`;
	const stored = await env.STUDY_STATE_KV.get(key, "json");
	if (stored) return stored;

	// default state if nothing is stored yet
	return {
		profile: {
			prefersShortSentences: true,
			weakAreas: [],
		},
		lastSession: null, // or { timestamp, goal, plan }
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

	const newState = {
		...state,
		lastSession: {
			timestamp: Date.now(),
			goal: message,
			plan: planText,
		},
	};

	return { reply: planText, newState };
}

async function revisePlan(state, message, env) {
	const lastPlan = state.lastSession ? state.lastSession.plan : "(none)";

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

	const newState = {
		...state,
		lastSession: {
			...(state.lastSession || { timestamp: Date.now(), goal: "(unknown)" }),
			plan: newPlan,
		},
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

	const reply = aiResult?.result || aiResult?.response || "Thanks for the update.";

	const newState = {
		...state,
		lastSession: state.lastSession
			? { ...state.lastSession, outcomeNote: message }
			: null,
	};

	return { reply, newState };
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Health check (optional)
		if (url.pathname === "/api/health") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Debug: inspect stored state
		// 
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
				routerResult?.result || routerResult?.response || '{"action":"create_plan"}';

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
