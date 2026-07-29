/**
 * AI Nishant — Cloudflare Worker
 * ------------------------------------------------------------
 * Sits between the Framer chat widget and the Gemini API.
 *
 * Responsibilities:
 *  1. Fetch nishant_knowledge.md from a public GitHub raw URL,
 *     cached for CACHE_TTL_SECONDS so edits to the file go live
 *     without redeploying this Worker.
 *  2. Build the request to Gemini: system prompt + knowledge +
 *     conversation history + the visitor's new message.
 *  3. Return a plain JSON reply the Framer widget can render.
 *
 * Required setup (see README.md):
 *  - wrangler.toml with a KV namespace binding: KNOWLEDGE_CACHE
 *  - Secret: GEMINI_API_KEY  (wrangler secret put GEMINI_API_KEY)
 *  - Variable: KNOWLEDGE_URL (raw GitHub URL to nishant_knowledge.md)
 *  - Variable: ALLOWED_ORIGIN (your Framer site origin, for CORS)
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour — tune as you like
const GEMINI_MODEL = "gemini-flash-latest"; // Google-maintained alias — always
// points to their current stable Flash model, so this won't break again when
// Google rotates model versions (as happened with gemini-2.5-flash retiring).
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const SYSTEM_PROMPT_HEADER = `
You are AI Nishant, a conversational stand-in for Nishant Kaku on his
personal portfolio site. Answer only using the knowledge document below.
Speak in first person, as Nishant would: direct, concise, no filler, no
corporate speak, no em dashes. If the answer isn't in the document, say
so plainly and point the visitor to the contact link on the site rather
than guessing. Never invent metrics, dates, names, or claims. Keep answers
to two to four sentences unless the visitor explicitly asks for depth.

--- KNOWLEDGE DOCUMENT START ---
`;

const SYSTEM_PROMPT_FOOTER = `
--- KNOWLEDGE DOCUMENT END ---
`;

async function getKnowledge(env) {
  // Try KV cache first.
  const cached = await env.KNOWLEDGE_CACHE.get("nishant_knowledge");
  if (cached) return cached;

  const res = await fetch(env.KNOWLEDGE_URL, {
    headers: { "User-Agent": "ai-nishant-worker" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch knowledge file: ${res.status}`);
  }
  const text = await res.text();

  // Strip the "Maintenance Notes" section before sending to the model —
  // that part of the file is for Nishant, not for the bot to see or quote.
  const trimmed = text.split("## Maintenance Notes")[0].trim();

  await env.KNOWLEDGE_CACHE.put("nishant_knowledge", trimmed, {
    expirationTtl: CACHE_TTL_SECONDS,
  });
  return trimmed;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const { message, history } = body;
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'message' string in body" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // Basic guardrails: cap message length and history size to control cost.
    const safeMessage = message.slice(0, 2000);
    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

    let knowledge;
    try {
      knowledge = await getKnowledge(env);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Could not load knowledge base", detail: String(err) }),
        { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const systemInstruction =
      SYSTEM_PROMPT_HEADER + knowledge + SYSTEM_PROMPT_FOOTER;

    // Build Gemini "contents" array from prior turns + new message.
    const contents = [
      ...safeHistory.map((turn) => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.text }],
      })),
      { role: "user", parts: [{ text: safeMessage }] },
    ];

    const geminiPayload = {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 400,
      },
    };

    let geminiRes;
    try {
      geminiRes = await fetch(GEMINI_URL(GEMINI_MODEL, env.GEMINI_API_KEY), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Gemini request failed", detail: String(err) }),
        { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(
        JSON.stringify({ error: "Gemini API error", detail: errText }),
        { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const data = await geminiRes.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "I couldn't generate a reply just now. Try again in a moment.";

    return new Response(JSON.stringify({ reply }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
