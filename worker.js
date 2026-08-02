/**
 * AI Nishant — Cloudflare Worker
 * ------------------------------------------------------------
 * Sits between the Framer chat widget and the LLM provider
 * (Gemini by default, Groq available for A/B testing via
 * ?provider=groq on the request URL).
 *
 * Responsibilities:
 *  1. Fetch nishant_knowledge.md from a public GitHub raw URL,
 *     cached for CACHE_TTL_SECONDS so edits to the file go live
 *     without redeploying this Worker.
 *  2. Build the request to the chosen provider: system prompt +
 *     knowledge + conversation history + the visitor's new message.
 *  3. Return a plain JSON reply the Framer widget can render.
 *
 * Required setup (see README.md):
 *  - wrangler.toml with a KV namespace binding: KNOWLEDGE_CACHE
 *  - Secret: GEMINI_API_KEY  (wrangler secret put GEMINI_API_KEY)
 *  - Secret: GROQ_API_KEY    (wrangler secret put GROQ_API_KEY)
 *  - Variable: KNOWLEDGE_URL (raw GitHub URL to nishant_knowledge.md)
 *  - Variable: ALLOWED_ORIGIN (your Framer site origin, for CORS)
 *
 * Testing Groq vs Gemini: append ?provider=groq to the Worker URL.
 * No query param (or anything else) falls back to Gemini.
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour — tune as you like

const GEMINI_MODEL = "gemini-3-flash";
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT_HEADER = `
You answer questions on Nishant Kaku's personal portfolio site. Follow the
persona and rules defined in the document below exactly — it defines who
you are, how to speak, and what to do when you don't know something.
Answer only using the document's content, never invent facts.

Respond in plain conversational sentences. Do not use markdown formatting
of any kind — no asterisks, no bold/italic syntax, no headers, no bullet
lists, no links in [text](url) form. Write the way a person would type
in a chat message.

If the document doesn't cover what's being asked, say so plainly and
honestly (e.g. "That's not something documented about Nishant's work")
rather than guessing, inferring, or denying something you're unsure about.
Never state a negative ("he hasn't done X") unless the document explicitly
says so — an absence of information is not the same as a "no".

You must respond with a JSON object with exactly two fields:
- "reply": your answer as a plain-text string, no markdown.
- "followups": an array of 2 to 3 short follow-up questions (each under 8
  words) that a visitor could naturally ask next, based on what you just
  said. Make them specific to this answer, not generic. Always include at
  least 2, even after answering something like a contact request — pivot
  to a different topic entirely (his projects, his philosophy, his
  background) rather than leaving the conversation with nowhere to go.
  Only use an empty array if you've truly covered everything in the
  document and there's nothing left to explore.

--- KNOWLEDGE DOCUMENT START ---
`;

const SYSTEM_PROMPT_FOOTER = `
--- KNOWLEDGE DOCUMENT END ---
`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    followups: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
  },
  required: ["reply", "followups"],
};

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

function parseReplyJson(rawText) {
  let reply = "Hmm, I couldn't generate a reply just now. Try again in a moment.";
  let followups = [];

  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (typeof parsed.reply === "string" && parsed.reply.trim()) {
        reply = parsed.reply.trim();
      }
      if (Array.isArray(parsed.followups)) {
        followups = parsed.followups
          .filter((f) => typeof f === "string" && f.trim())
          .slice(0, 3);
      }
    } catch {
      // Schema mode should prevent this, but fall back to raw text
      // rather than failing the whole request if it ever happens.
      reply = rawText.trim();
    }
  }

  return { reply, followups };
}

// ---- Gemini ----

async function callGemini(systemInstruction, safeHistory, safeMessage, env) {
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
      temperature: 0.65,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const geminiRes = await fetch(GEMINI_URL(GEMINI_MODEL, env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiPayload),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw new Error(`Gemini API error: ${errText}`);
  }

  const data = await geminiRes.json();
  const rawText =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

  return parseReplyJson(rawText);
}

// ---- Groq ----

async function callGroq(systemInstruction, safeHistory, safeMessage, env) {
  const messages = [
    { role: "system", content: systemInstruction },
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.text,
    })),
    { role: "user", content: safeMessage },
  ];

  const groqRes = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.65,
      max_tokens: 400,
      response_format: { type: "json_object" },
    }),
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq API error: ${errText}`);
  }

  const data = await groqRes.json();
  const rawText = data?.choices?.[0]?.message?.content || "";

  return parseReplyJson(rawText);
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

    // Allow ?provider=gemini to force Gemini directly (useful for testing),
    // but by default Groq is primary with Gemini as automatic fallback.
    const url = new URL(request.url);
    const forceProvider = url.searchParams.get("provider");

    let result;
    let providerUsed;

    if (forceProvider === "gemini") {
      try {
        result = await callGemini(systemInstruction, safeHistory, safeMessage, env);
        providerUsed = "gemini";
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "gemini request failed", detail: String(err) }),
          { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
        );
      }
    } else {
      // Primary: Groq. On any failure — rate limit or otherwise — fall
      // back to Gemini rather than surfacing an error to the visitor.
      try {
        result = await callGroq(systemInstruction, safeHistory, safeMessage, env);
        providerUsed = "groq";
      } catch (groqErr) {
        try {
          result = await callGemini(systemInstruction, safeHistory, safeMessage, env);
          providerUsed = "gemini-fallback";
        } catch (geminiErr) {
          // Both providers failed — this is the only case that surfaces
          // an actual error to the widget.
          return new Response(
            JSON.stringify({
              error: "Both providers failed",
              detail: `groq: ${String(groqErr)} | gemini: ${String(geminiErr)}`,
            }),
            { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
          );
        }
      }
    }

    return new Response(JSON.stringify({ ...result, provider: providerUsed }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
