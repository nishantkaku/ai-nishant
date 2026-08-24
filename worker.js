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
 *  - Variables: GROQ_MODEL_PRIMARY, GROQ_MODEL_BACKUP,
 *    GEMINI_MODEL_PRIMARY, GEMINI_MODEL_BACKUP -- optional, fall back to
 *    the *_DEFAULT constants below if unset. Changing these in
 *    wrangler.toml is a config-only change (no edit to this file) but
 *    it still does not take effect until you run `wrangler deploy` --
 *    editing the file alone does not update the live Worker.
 *
 * Testing Groq vs Gemini: append ?provider=gemini to the Worker URL
 * to force Gemini directly (bypassing Groq only -- static answers are
 * still checked first regardless of this parameter, same as normal).
 */

const CACHE_TTL_SECONDS = 3600; // 1 hour -- tune as you like

// Per-attempt fetch timeout, and an overall wall-clock budget across every
// candidate + retry combined, so a visitor is never left waiting through
// four full timeout cycles. Keep OVERALL_REQUEST_BUDGET_MS comfortably
// under the Framer widget's own request timeout (30s as of this writing).
const PER_ATTEMPT_TIMEOUT_MS = 7000;
const OVERALL_REQUEST_BUDGET_MS = 18000;

// ------------------------------------------------------------
// Model configuration -- controlled failover, not open-ended discovery.
// Exactly four approved candidates, tried in a fixed order:
//   Groq primary -> Groq backup -> Gemini primary -> Gemini backup
// Model IDs come from env vars (wrangler.toml [vars]) with hardcoded
// defaults as a safety net if a var is ever missing -- swapping a model
// only requires editing config + `wrangler deploy`, never this file.
// Verified against each provider's current docs as of Aug 2026.
//
// Primary/backup order is deliberately 20B-first: this Worker's job is
// "read supplied knowledge, answer a grounded question, return small
// JSON" -- not a task that benefits from the larger 120B model's extra
// capability, and 20B is faster/cheaper. Swap the two env vars if
// evaluation ever shows 20B answer quality falling short.
// ------------------------------------------------------------

const GROQ_MODEL_PRIMARY_DEFAULT = "openai/gpt-oss-20b";
const GROQ_MODEL_BACKUP_DEFAULT = "openai/gpt-oss-120b";
const GEMINI_MODEL_PRIMARY_DEFAULT = "gemini-3.6-flash";
const GEMINI_MODEL_BACKUP_DEFAULT = "gemini-3.5-flash-lite";

const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function buildCandidateChain(env) {
  return [
    { provider: "groq", model: env.GROQ_MODEL_PRIMARY || GROQ_MODEL_PRIMARY_DEFAULT },
    { provider: "groq", model: env.GROQ_MODEL_BACKUP || GROQ_MODEL_BACKUP_DEFAULT },
    { provider: "gemini", model: env.GEMINI_MODEL_PRIMARY || GEMINI_MODEL_PRIMARY_DEFAULT },
    { provider: "gemini", model: env.GEMINI_MODEL_BACKUP || GEMINI_MODEL_BACKUP_DEFAULT },
  ];
}

// ------------------------------------------------------------
// Error classification -- different failures get different responses,
// not a one-size-fits-all "try the next thing" retry.
//
//   model_unavailable (404 / model_not_found / decommissioned)
//     -> move to the next candidate immediately, no retry (retrying the
//        same dead model wastes a request for nothing).
//   rate_limited (429 / quota)
//     -> skip every remaining candidate on THIS provider and jump
//        straight to the other provider (repeatedly hitting a
//        rate-limited provider with a different model rarely helps).
//   auth_config (401 / 403)
//     -> same as rate_limited: this is a provider/config-level problem,
//        not a model problem, so skip the rest of this provider.
//   transient (5xx, or the fetch itself threw/timed out)
//     -> allow exactly one immediate retry on the SAME model, then
//        move to the next candidate if it's still failing.
//   malformed (HTTP 200 but no usable text came back)
//     -> allow exactly one retry on the SAME model, then move on.
// ------------------------------------------------------------

function classifyFailure(status, bodyText) {
  const text = String(bodyText || "");
  if (status === 404 || /model_not_found|model_decommissioned|does not exist|no longer available/i.test(text)) {
    return "model_unavailable";
  }
  if (status === 429 || /rate.?limit|quota/i.test(text)) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) {
    return "auth_config";
  }
  if (status >= 500 && status < 600) {
    return "transient";
  }
  if (status === 0) {
    // fetch threw (network error/timeout) rather than returning a status
    return "transient";
  }
  return "unknown";
}

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
    q.includes("education") ||
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
    q.includes("role") ||
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
    q.includes("companies") ||
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

// Groq's Structured Outputs (response_format: json_schema, strict mode)
// requires additionalProperties: false to guarantee the schema is matched
// exactly -- see console.groq.com/docs/structured-outputs. Both
// openai/gpt-oss-20b and openai/gpt-oss-120b support this.
const GROQ_JSON_SCHEMA = {
  name: "portfolio_reply",
  strict: true,
  schema: {
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
    additionalProperties: false,
  },
};

// Shown only when every approved candidate (Groq primary/backup, Gemini
// primary/backup) has failed. Deliberately steers back to the always-on
// static answers rather than exposing any technical detail.
const FRIENDLY_FALLBACK = {
  reply:
    "I'm having trouble putting together a full answer right now. In the " +
    "meantime you can still ask about Nishant's contact details, resume, " +
    "education, certifications, current role, or the companies he's " +
    "worked with -- those are always available.",
  followups: ["What companies has he worked with?", "How can I contact him?"],
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

// AbortController-backed fetch so a slow/hanging provider can never hold
// a request open indefinitely -- always cleans up its timer either way.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Strict by design: returns null on ANYTHING that isn't a fully-conforming
// { reply: non-empty string, followups: string[] } object -- invalid JSON,
// a missing field, or the wrong type all count as malformed. This is
// deliberate: arbitrary raw text (e.g. a model ignoring its JSON
// instruction and chatting in prose) must never silently become a
// "successful" reply -- it should trigger the same retry/failover path
// as any other failure.
function parseReplyJson(rawText) {
  if (!rawText || !rawText.trim()) return null;

  try {
    const parsed = JSON.parse(rawText);
    if (
      typeof parsed.reply !== "string" ||
      !parsed.reply.trim() ||
      !Array.isArray(parsed.followups)
    ) {
      return null;
    }
    return {
      reply: parsed.reply.trim(),
      followups: parsed.followups
        .filter((f) => typeof f === "string" && f.trim())
        .slice(0, 3),
    };
  } catch {
    return null;
  }
}

async function callGeminiOnce(model, systemInstruction, safeHistory, safeMessage, env, timeoutMs) {
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

  let geminiRes;
  try {
    geminiRes = await fetchWithTimeout(
      GEMINI_URL(model, env.GEMINI_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      },
      timeoutMs
    );
  } catch (networkErr) {
    return { ok: false, status: 0, errorText: String(networkErr) };
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return { ok: false, status: geminiRes.status, errorText: errText };
  }

  const data = await geminiRes.json();
  const rawText =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

  const result = parseReplyJson(rawText);
  if (!result) {
    return { ok: true, status: geminiRes.status, malformed: true };
  }
  return { ok: true, status: geminiRes.status, result };
}

async function callGroqOnce(model, systemInstruction, safeHistory, safeMessage, env, timeoutMs) {
  const messages = [
    { role: "system", content: systemInstruction },
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.text,
    })),
    { role: "user", content: safeMessage },
  ];

  let groqRes;
  try {
    groqRes = await fetchWithTimeout(
      GROQ_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.65,
          max_tokens: 400,
          response_format: { type: "json_schema", json_schema: GROQ_JSON_SCHEMA },
        }),
      },
      timeoutMs
    );
  } catch (networkErr) {
    return { ok: false, status: 0, errorText: String(networkErr) };
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return { ok: false, status: groqRes.status, errorText: errText };
  }

  const data = await groqRes.json();
  const rawText = data?.choices?.[0]?.message?.content || "";

  const result = parseReplyJson(rawText);
  if (!result) {
    return { ok: true, status: groqRes.status, malformed: true };
  }
  return { ok: true, status: groqRes.status, result };
}

// Runs one candidate model end-to-end: the call, plus exactly one retry
// if (and only if) the failure is transient (5xx/network/timeout) or the
// response came back malformed. Every fetch is bounded by the smaller of
// PER_ATTEMPT_TIMEOUT_MS and whatever's left of the overall request
// budget -- if the budget is already gone, the candidate is skipped
// (and, on a retry decision, the retry is skipped) rather than starting
// a call that can't finish in time anyway.
async function attemptModel(candidate, systemInstruction, safeHistory, safeMessage, env, deadlineTs) {
  const callFn = candidate.provider === "groq" ? callGroqOnce : callGeminiOnce;
  const start = Date.now();
  const timeLeft = () => deadlineTs - Date.now();

  if (timeLeft() <= 0) {
    return {
      provider: candidate.provider,
      model: candidate.model,
      status: 0,
      latency_ms: 0,
      category: "budget_exceeded",
      success: false,
      result: null,
    };
  }

  let attempt = await callFn(
    candidate.model, systemInstruction, safeHistory, safeMessage, env,
    Math.min(PER_ATTEMPT_TIMEOUT_MS, timeLeft())
  );
  let category = attempt.ok ? (attempt.malformed ? "malformed" : null) : classifyFailure(attempt.status, attempt.errorText);

  if ((category === "transient" || category === "malformed") && timeLeft() > 0) {
    attempt = await callFn(
      candidate.model, systemInstruction, safeHistory, safeMessage, env,
      Math.min(PER_ATTEMPT_TIMEOUT_MS, timeLeft())
    );
    category = attempt.ok ? (attempt.malformed ? "malformed" : null) : classifyFailure(attempt.status, attempt.errorText);
  }

  return {
    provider: candidate.provider,
    model: candidate.model,
    status: attempt.status,
    latency_ms: Date.now() - start,
    category, // null on success
    success: attempt.ok && !attempt.malformed,
    result: attempt.ok && !attempt.malformed ? attempt.result : null,
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

    const url = new URL(request.url);
    const forceProvider = url.searchParams.get("provider");

    const systemInstruction =
      SYSTEM_PROMPT_HEADER + knowledge + SYSTEM_PROMPT_FOOTER;

    // ?provider=gemini restricts the chain to Gemini's two candidates only
    // (unchanged behaviour from before -- still bypasses Groq entirely).
    const fullChain = buildCandidateChain(env);
    const chain =
      forceProvider === "gemini"
        ? fullChain.filter((c) => c.provider === "gemini")
        : fullChain;

    const attemptLog = [];
    let skipProvider = null; // set after a rate_limited/auth_config failure
    let finalResult = null;
    let providerUsed = null;
    let modelUsed = null;
    const deadlineTs = Date.now() + OVERALL_REQUEST_BUDGET_MS;

    for (const candidate of chain) {
      const isFirstAttempt = attemptLog.length === 0;

      if (candidate.provider === skipProvider) {
        attemptLog.push({
          provider: candidate.provider,
          model: candidate.model,
          skipped: true,
          reason: "provider already flagged this request",
        });
        continue;
      }

      if (Date.now() >= deadlineTs) {
        attemptLog.push({
          provider: candidate.provider,
          model: candidate.model,
          skipped: true,
          reason: "overall request time budget exceeded",
        });
        continue;
      }

      const attempt = await attemptModel(candidate, systemInstruction, safeHistory, safeMessage, env, deadlineTs);
      attemptLog.push({
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status,
        latency_ms: attempt.latency_ms,
        failure_category: attempt.category,
        fallback_triggered: !isFirstAttempt,
      });

      if (attempt.success) {
        finalResult = attempt.result;
        modelUsed = candidate.model;
        const groqAttemptedFirst = attemptLog.some((a) => a.provider === "groq" && !a.skipped);
        providerUsed = candidate.provider === "gemini" && groqAttemptedFirst ? "gemini-fallback" : candidate.provider;
        break;
      }

      if (attempt.category === "rate_limited" || attempt.category === "auth_config") {
        skipProvider = candidate.provider;
      }
    }

    console.log(
      JSON.stringify({
        event: finalResult ? "ai_nishant_success" : "ai_nishant_failure",
        provider: providerUsed,
        model: modelUsed,
        attempts: attemptLog,
      })
    );

    if (!finalResult) {
      // Intentional 200: this is a designed, user-facing message the
      // Framer widget should render normally, not a transport failure
      // for it to special-case. The real error detail is in the log
      // line above (Cloudflare Observability), never in this response.
      return new Response(
        JSON.stringify({ ...FRIENDLY_FALLBACK, provider: "fallback" }),
        { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // `model` is an optional diagnostic field for your own debugging /
    // Observability correlation -- the Framer widget can safely ignore
    // it; `reply` and `followups` are unchanged in shape from before.
    return new Response(
      JSON.stringify({ ...finalResult, provider: providerUsed, model: modelUsed }),
      { headers: { ...headers, "Content-Type": "application/json" } }
    );
  },
};