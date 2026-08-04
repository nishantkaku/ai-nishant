/**
 * AI Nishant -- Cloudflare Worker
 * ------------------------------------------------------------
 * Sits between the Framer chat widget and the LLM provider
 * (Groq primary, Gemini automatic fallback on any Groq failure).
 *
 * Responsibilities:
 *  1. Check the visitor's message against a small set of static
 *     answers first (contact, resume, certifications, education,
 *     current role, companies) -- these are answered instantly with
 *     zero AI calls and zero token cost, and work even if both
 *     Groq and Gemini are down.
 *  2. If no static match, fetch nishant_knowledge.md from a public
 *     GitHub raw URL, cached for CACHE_TTL_SECONDS so edits to the
 *     file go live without redeploying this Worker.
 *  3. Build the request to the chosen provider: system prompt +
 *     knowledge + conversation history + the visitor's new message.
 *  4. Return a plain JSON reply the Framer widget can render.
 *
 * Required setup (see README.md):
 *  - wrangler.toml with a KV namespace binding: KNOWLEDGE_CACHE
 *  - Secret: GEMINI_API_KEY  (wrangler secret put GEMINI_API_KEY)
 *  - Secret: GROQ_API_KEY    (wrangler secret put GROQ_API_KEY)
 *  - Variable: KNOWLEDGE_URL (raw GitHub URL to nishant_knowledge.md)
 *  - Variable: ALLOWED_ORIGIN (your Framer site origin, for CORS)
 *
 * Testing Groq vs Gemini: append ?provider=gemini to the Worker URL
 * to force Gemini directly (bypassing Groq and the static layer).
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour -- tune as you like

const GEMINI_MODEL = "gemini-2.0-flash-001";
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ------------------------------------------------------------
// Static answers -- no AI call, no tokens spent, always available.
// Links use the same [text](url) Markdown syntax the frontend
// already parses into clickable chips, so no frontend change is
// needed to support this.
// ------------------------------------------------------------

const RESUME_URL =
  "https://raw.githubusercontent.com/nishantkaku/ai-nishant/main/Resume.pdf";
const LINKEDIN_URL = "https://www.linkedin.com/in/nishantkaku";
const INSTAGRAM_URL = "https://www.instagram.com/nishantkaku";
const BEHANCE_URL = "https://www.behance.net/nishantkaku";
const X_URL = "https://x.com/nishantkaku";

const STATIC_ANSWERS = {
  contact: {
    reply:
      `You can reach Nishant through his email at nishant.kaku@gmail.com, ` +
      `or connect with him via [LinkedIn](${LINKEDIN_URL}), ` +
      `[Instagram](${INSTAGRAM_URL}), [Behance](${BEHANCE_URL}), or ` +
      `[X](${X_URL}). His resume is also available at [Resume](${RESUME_URL}).`,
    followups: [
      "What is his design philosophy?",
      "What companies has he worked with?",
      "Can I see his resume?",
    ],
  },
  resume: {
    reply: `Here's Nishant's resume: [Resume](${RESUME_URL})`,
    followups: ["How do I reach him?", "What is his design philosophy?"],
  },
  certifications: {
    reply:
      "Nishant holds two HFI certifications: Certified Usability Analyst " +
      "(CUA) and Certified User Experience Analyst (CXA).",
    followups: ["Where did he study?", "What is his current role?"],
  },
  education: {
    reply:
      "Nishant holds an Executive MBA from the Indian School of Business " +
      "(ISB), Hyderabad, and a Master of Fine Arts from Arunachal " +
      "University of Studies, alongside his HFI certifications.",
    followups: [
      "What are his certifications?",
      "What companies has he worked with?",
    ],
  },
  role: {
    reply:
      "Nishant is currently Head of UX Design and Research at Housing.com " +
      "(REA India), leading a team of designers across the company's core " +
      "product experiences.",
    followups: [
      "What companies has he worked with?",
      "What is his design philosophy?",
    ],
  },
  companies: {
    reply:
      "Nishant has worked across Housing.com, Cashfree Payments, Jubilant " +
      "FoodWorks (Domino's, Dunkin', Popeyes), Info Edge (Shiksha), Paytm, " +
      "India Today, and Brentwoods.",
    followups: [
      "What was his role at Housing.com?",
      "What is his current role?",
    ],
  },
};

// Checked in this order -- first match wins. Keep phrasing checks
// broad but specific enough to avoid false positives (e.g. "study"
// alone could be too broad; "study" plus context words is safer if
// this ever needs tightening).
function findStaticAnswer(message) {
  const q = message.toLowerCase();

  if (q.includes("resume") || q.includes(" cv") || q.includes("cv?")) {
    return STATIC_ANSWERS.resume;
  }

  if (
    q.includes("contact") ||
    q.includes("reach him") ||
    q.includes("reach nishant") ||
    q.includes("get in touch") ||
    q.includes("email") ||
    q.includes("linkedin") ||
    q.includes("instagram") ||
    q.includes("behance") ||
    q.includes("social media") ||
    q.includes("his social")
  ) {
    return STATIC_ANSWERS.contact;
  }

  if (
    q.includes("certification") ||
    q.includes(" cua") ||
    q.includes(" cxa") ||
    q.includes("certified")
  ) {
    return STATIC_ANSWERS.certifications;
  }

  if (
    q.includes("where did he study") ||
    q.includes("his education") ||
    q.includes("mba") ||
    q.includes("degree") ||
    q.includes("university") ||
    q.includes("mfa")
  ) {
    return STATIC_ANSWERS.education;
  }

  if (
    q.includes("current role") ||
    q.includes("his role") ||
    q.includes("what does he do") ||
    q.includes("job title") ||
    q.includes("designation") ||
    q.includes("where does he work")
  ) {
    return STATIC_ANSWERS.role;
  }

  if (
    q.includes("companies has he") ||
    q.includes("companies he") ||
    q.includes("worked with") ||
    q.includes("career history") ||
    q.includes("where has he worked") ||
    q.includes("previous companies") ||
    q.includes("past companies")
  ) {
    return STATIC_ANSWERS.companies;
  }

  return null;
}

const SYSTEM_PROMPT_HEADER = `
You answer questions on Nishant Kaku's personal portfolio site. Follow the
persona and rules defined in the document below exactly -- it defines who
you are, how to speak, and what to do when you don't know something.
Answer only using the document's content, never invent facts.

Respond in plain conversational sentences. Do not use markdown formatting
of any kind -- no asterisks, no bold/italic syntax, no headers, no bullet
lists. Write the way a person would type in a chat message.

The one exception: when your answer includes a link the document provides
(such as his resume, LinkedIn, Instagram, Behance, or X), always include
it using Markdown link syntax [text](url) exactly as given in the
document -- never paraphrase it as "visit the contact link on the site"
or similar. State the link directly, every time it's relevant.

If the document doesn't cover what's being asked, say so plainly and
honestly (e.g. "That's not something documented about Nishant's work")
rather than guessing, inferring, or denying something you're unsure about.
Never state a negative ("he hasn't done X") unless the document explicitly
says so -- an absence of information is not the same as a "no".

When mentioning years of experience, metrics, percentages, or currency
figures, always use a consistent format: a number followed directly by
"+" or "%" where applicable (e.g. "20+ years", "46%+", "Rs. 20 crore"),
never spelled out or rephrased. Always refer to companies by their full
stated name (e.g. "Housing.com", "Jubilant FoodWorks," not "Jubilant"
alone).

You must respond with a JSON object with exactly two fields:
- "reply": your answer as a plain-text string, no markdown.
- "followups": an array of 2 to 3 short follow-up questions (each under 8
  words) that a visitor could naturally ask next, based on what you just
  said. Make them specific to this answer, not generic. Always include at
  least 2, even after answering something like a contact request -- pivot
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
  const cached = await env.KNOWLEDGE_CACHE.get("nishant_knowledge");
  if (cached) return cached;

  const res = await fetch(env.KNOWLEDGE_URL, {
    headers: { "User-Agent": "ai-nishant-worker" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch knowledge file: ${res.status}`);
  }
  const text = await res.text();

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
      reply = rawText.trim();
    }
  }

  return { reply, followups };
}

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

    const safeMessage = message.slice(0, 2000);
    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];

    // Static-answer check happens first -- before any knowledge fetch or
    // provider call. Zero tokens spent, works even if both Groq and
    // Gemini are down.
    const staticAnswer = findStaticAnswer(safeMessage);
    if (staticAnswer) {
      return new Response(
        JSON.stringify({ ...staticAnswer, provider: "static" }),
        { headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

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