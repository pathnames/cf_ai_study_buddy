const BASE_URL = import.meta.env.VITE_API_BASE_URL || "";

async function jsonFetch(path, options = {}) {
    const res = await fetch(BASE_URL + path, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Request failed ${res.status}: ${text}`);
    }
    return res.json();
}

export async function sendChat(message) {
    return jsonFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message }),
    });
}

export async function fetchState() {
    return jsonFetch("/debug/state");
}

export async function resetState() {
    return jsonFetch("/debug/reset");
}

export async function healthCheck() {
    return jsonFetch("/api/health");
}
