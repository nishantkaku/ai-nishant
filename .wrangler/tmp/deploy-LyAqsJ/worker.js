var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CACHE_TTL_SECONDS = 3600;
var GEMINI_MODEL = "gemini-2.5-flash";
var GEMINI_URL = /* @__PURE__ */ __name((model, key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, "GEMINI_URL");
var GROQ_MODEL = "llama-3.3-70b-versatile";
var GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
var SYSTEM_PROMPT_HEADER = `
You answer questions on Nishant Kaku's personal portfolio site. Follow the
persona and rules defined in the document below exactly \u2014 it defines who
you are, how to speak, and what to do when you don't know something.
Answer only using the document's content, never invent facts.

Respond in plain conversational sentences. Do not use markdown formatting
of any kind \u2014 no asterisks, no bold/italic syntax, no headers, no bullet
lists. Write the way a person would type in a chat message.

The one exception: when your answer includes a link the document provides
(such as his resume, LinkedIn, Instagram, Behance, or X), always include
it using Markdown link syntax [text](url) exactly as given in the
document \u2014 never paraphrase it as "visit the contact link on the site"
or similar. State the link directly, every time it's relevant.

If the document doesn't cover what's being asked, say so plainly and
honestly (e.g. "That's not something documented about Nishant's work")
rather than guessing, inferring, or denying something you're unsure about.
Never state a negative ("he hasn't done X") unless the document explicitly
says so \u2014 an absence of information is not the same as a "no".

When mentioning years of experience, metrics, percentages, or currency
figures, always use a consistent format: a number followed directly by
"+" or "%" where applicable (e.g. "20+ years", "46%+", "\u20B920 crore"),
never spelled out or rephrased. Always refer to companies by their full
stated name (e.g. "Housing.com", "Jubilant FoodWorks," not "Jubilant"
alone).

You must respond with a JSON object with exactly two fields:
- "reply": your answer as a plain-text string, no markdown.
- "followups": an array of 2 to 3 short follow-up questions (each under 8
  words) that a visitor could naturally ask next, based on what you just
  said. Make them specific to this answer, not generic. Always include at
  least 2, even after answering something like a contact request \u2014 pivot
  to a different topic entirely (his projects, his philosophy, his
  background) rather than leaving the conversation with nowhere to go.
  Only use an empty array if you've truly covered everything in the
  document and there's nothing left to explore.

--- KNOWLEDGE DOCUMENT START ---
`;
var SYSTEM_PROMPT_FOOTER = `
--- KNOWLEDGE DOCUMENT END ---
`;
var RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    followups: {
      type: "array",
      items: { type: "string" },
      maxItems: 3
    }
  },
  required: ["reply", "followups"]
};
async function getKnowledge(env) {
  const cached = await env.KNOWLEDGE_CACHE.get("nishant_knowledge");
  if (cached) return cached;
  const res = await fetch(env.KNOWLEDGE_URL, {
    headers: { "User-Agent": "ai-nishant-worker" }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch knowledge file: ${res.status}`);
  }
  const text = await res.text();
  const trimmed = text.split("## Maintenance Notes")[0].trim();
  await env.KNOWLEDGE_CACHE.put("nishant_knowledge", trimmed, {
    expirationTtl: CACHE_TTL_SECONDS
  });
  return trimmed;
}
__name(getKnowledge, "getKnowledge");
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
__name(corsHeaders, "corsHeaders");
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
        followups = parsed.followups.filter((f) => typeof f === "string" && f.trim()).slice(0, 3);
      }
    } catch {
      reply = rawText.trim();
    }
  }
  return { reply, followups };
}
__name(parseReplyJson, "parseReplyJson");
async function callGemini(systemInstruction, safeHistory, safeMessage, env) {
  const contents = [
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text }]
    })),
    { role: "user", parts: [{ text: safeMessage }] }
  ];
  const geminiPayload = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature: 0.65,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  };
  const geminiRes = await fetch(GEMINI_URL(GEMINI_MODEL, env.GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiPayload)
  });
  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw new Error(`Gemini API error: ${errText}`);
  }
  const data = await geminiRes.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return parseReplyJson(rawText);
}
__name(callGemini, "callGemini");
async function callGroq(systemInstruction, safeHistory, safeMessage, env) {
  const messages = [
    { role: "system", content: systemInstruction },
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.text
    })),
    { role: "user", content: safeMessage }
  ];
  const groqRes = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.65,
      max_tokens: 400,
      response_format: { type: "json_object" }
    })
  });
  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq API error: ${errText}`);
  }
  const data = await groqRes.json();
  const rawText = data?.choices?.[0]?.message?.content || "";
  return parseReplyJson(rawText);
}
__name(callGroq, "callGroq");
var worker_default = {
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
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }
    const { message, history } = body;
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'message' string in body" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }
    const safeMessage = message.slice(0, 2e3);
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
    const systemInstruction = SYSTEM_PROMPT_HEADER + knowledge + SYSTEM_PROMPT_FOOTER;
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
      try {
        result = await callGroq(systemInstruction, safeHistory, safeMessage, env);
        providerUsed = "groq";
      } catch (groqErr) {
        try {
          result = await callGemini(systemInstruction, safeHistory, safeMessage, env);
          providerUsed = "gemini-fallback";
        } catch (geminiErr) {
          return new Response(
            JSON.stringify({
              error: "Both providers failed",
              detail: `groq: ${String(groqErr)} | gemini: ${String(geminiErr)}`
            }),
            { status: 502, headers: { ...headers, "Content-Type": "application/json" } }
          );
        }
      }
    }
    return new Response(JSON.stringify({ ...result, provider: providerUsed }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
