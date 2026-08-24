const CACHE_TTL_SECONDS = 3600;
const HISTORY_TURN_LIMIT = 4;
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_CHARS = 1000;
const PROVIDER_TIMEOUT_MS = 9000;

const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const RESUME_URL = "https://raw.githubusercontent.com/nishantkaku/ai-nishant/main/Resume.pdf";
const LINKEDIN_URL = "https://www.linkedin.com/in/nishantkaku";
const INSTAGRAM_URL = "https://www.instagram.com/nishantkaku";
const BEHANCE_URL = "https://www.behance.net/nishantkaku";
const X_URL = "https://x.com/nishantkaku";

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
  additionalProperties: false,
};

const FRIENDLY_FALLBACK = {
  reply:
    "I am having trouble generating a fresh answer right now. You can still ask about Nishant's contact details, resume, education, certifications, current role, or companies he has worked with.",
  followups: [
    "How do I contact him?",
    "Can I see his resume?",
    "Where does he work?",
  ],
};

const STATIC_ANSWERS = {
  contact: {
    reply: `You can reach Nishant through his email at nishant.kaku@gmail.com, or connect with him via [LinkedIn](${LINKEDIN_URL}), [Instagram](${INSTAGRAM_URL}), [Behance](${BEHANCE_URL}), or [X](${X_URL}). His resume is also available at [Resume](${RESUME_URL}).`,
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
      "Nishant holds two HFI certifications: Certified Usability Analyst (CUA) and Certified User Experience Analyst (CXA).",
    followups: ["Where did he study?", "What is his current role?"],
  },
  education: {
    reply:
      "Nishant holds an Executive MBA from the Indian School of Business (ISB), Hyderabad, and a Master of Fine Arts from Arunachal University of Studies, alongside his HFI certifications.",
    followups: ["What are his certifications?", "What companies has he worked with?"],
  },
  role: {
    reply:
      "Nishant is currently Head of UX Design and Research at Housing.com (REA India), leading a team of designers across the company's core product experiences.",
    followups: ["What companies has he worked with?", "What is his design philosophy?"],
  },
  companies: {
    reply:
      "Nishant has worked across Housing.com, Cashfree Payments, Jubilant FoodWorks (Domino's, Dunkin', Popeyes), Info Edge (Shiksha), Paytm, India Today, and Brentwoods.",
    followups: ["What was his role at Housing.com?", "What is his current role?"],
  },
};

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
  if (q.includes("certification") || q.includes(" cua") || q.includes(" cxa") || q.includes("certified")) {
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

function jsonResponse(body, headers, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function uniqueList(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function getProviderModels(env) {
  return {
    groq: uniqueList([
      env.GROQ_MODEL_PRIMARY || "openai/gpt-oss-20b",
      env.GROQ_MODEL_BACKUP || "openai/gpt-oss-120b",
    ]),
    cfai: uniqueList([env.CF_AI_MODEL || "@cf/openai/gpt-oss-20b"]),
    gemini: uniqueList([
      env.GEMINI_MODEL_PRIMARY || "gemini-3.6-flash",
      env.GEMINI_MODEL_BACKUP || "gemini-3.5-flash-lite",
    ]),
  };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant"))
    .map((turn) => ({
      role: turn.role,
      text: String(turn.text || turn.content || "").slice(0, MAX_HISTORY_CHARS),
    }))
    .filter((turn) => turn.text.trim())
    .slice(-HISTORY_TURN_LIMIT);
}

function buildMessages(systemInstruction, safeHistory, safeMessage) {
  return [
    { role: "system", content: systemInstruction },
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.text,
    })),
    { role: "user", content: safeMessage },
  ];
}

function withTimeout(ms = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("provider_timeout"), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function normalizeReplyObject(value) {
  if (
    !value ||
    typeof value.reply !== "string" ||
    !value.reply.trim() ||
    !Array.isArray(value.followups)
  ) {
    return null;
  }

  return {
    reply: value.reply.trim(),
    followups: value.followups
      .filter((f) => typeof f === "string" && f.trim())
      .map((f) => f.trim())
      .slice(0, 3),
  };
}

function parseReplyJson(rawValue) {
  if (rawValue && typeof rawValue === "object") {
    return normalizeReplyObject(rawValue);
  }

  if (!rawValue || typeof rawValue !== "string") return null;

  const cleaned = rawValue
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    return normalizeReplyObject(parsed);
  } catch {
    return null;
  }
}

function classifyFailure(status, body = "") {
  const text = body.toLowerCase();

  if (status === 408 || status === 504 || text.includes("timeout")) return "timeout";
  if (status === 429 || text.includes("rate") || text.includes("quota") || text.includes("resource_exhausted")) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) return "auth_or_permission";
  if (
    status === 404 ||
    text.includes("model_not_found") ||
    text.includes("not found") ||
    text.includes("no longer available") ||
    text.includes("deprecated") ||
    text.includes("decommissioned")
  ) {
    return "model_unavailable";
  }
  if (status >= 500) return "provider_error";
  if (status >= 400) return "request_rejected";
  return "unknown";
}

function logAttempt(event) {
  console.log(
    JSON.stringify({
      event: "ai_provider_attempt",
      provider: event.provider,
      model: event.model,
      status: event.status || null,
      reason: event.reason || null,
      latencyMs: event.latencyMs,
      fallbackTriggered: Boolean(event.fallbackTriggered),
      retryAfter: event.retryAfter || null,
      remainingTokens: event.remainingTokens || null,
      cachedTokens: event.cachedTokens ?? null,
    })
  );
}

async function callGroq(model, messages, env) {
  const timer = withTimeout();
  const started = Date.now();

  try {
    const response = await fetch(GROQ_URL, {
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
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "portfolio_chatbot_reply",
            strict: true,
            schema: RESPONSE_SCHEMA,
          },
        },
      }),
      signal: timer.signal,
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        provider: "groq",
        model,
        status: response.status,
        reason: classifyFailure(response.status, body),
        latencyMs,
        retryAfter: response.headers.get("retry-after"),
        remainingTokens: response.headers.get("x-ratelimit-remaining-tokens"),
      };
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content || "";
    const parsed = parseReplyJson(rawText);

    return {
      ok: Boolean(parsed),
      provider: "groq",
      model,
      status: response.status,
      reason: parsed ? null : "malformed_json",
      latencyMs,
      result: parsed,
      cachedTokens: data?.usage?.prompt_tokens_details?.cached_tokens,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "groq",
      model,
      status: null,
      reason: error?.name === "AbortError" ? "timeout" : "network_error",
      latencyMs: Date.now() - started,
    };
  } finally {
    timer.clear();
  }
}

async function callCloudflareAi(model, messages, env) {
  const started = Date.now();

  if (!env.AI || env.ENABLE_CF_AI_FALLBACK !== "true") {
    return {
      ok: false,
      provider: "cfai",
      model,
      status: null,
      reason: "not_configured",
      latencyMs: 0,
    };
  }

  try {
    const response = await env.AI.run(model, {
      messages,
      temperature: 0.6,
      max_tokens: 400,
      response_format: {
        type: "json_schema",
        json_schema: RESPONSE_SCHEMA,
      },
    });

    const rawValue = response?.response || response;
    const parsed = parseReplyJson(rawValue);

    return {
      ok: Boolean(parsed),
      provider: "cfai",
      model,
      status: 200,
      reason: parsed ? null : "malformed_json",
      latencyMs: Date.now() - started,
      result: parsed,
      cachedTokens: response?.usage?.prompt_tokens_details?.cached_tokens,
    };
  } catch (error) {
    const body = String(error?.message || error);
    const statusMatch = body.match(/\b(4\d\d|5\d\d)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : null;

    return {
      ok: false,
      provider: "cfai",
      model,
      status,
      reason: classifyFailure(status || 500, body),
      latencyMs: Date.now() - started,
    };
  }
}

async function callGemini(model, systemInstruction, safeHistory, safeMessage, env) {
  const timer = withTimeout();
  const started = Date.now();

  const contents = [
    ...safeHistory.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: safeMessage }] },
  ];

  const payload = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature: 0.65,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  try {
    const response = await fetch(GEMINI_URL(model, env.GEMINI_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timer.signal,
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        provider: "gemini",
        model,
        status: response.status,
        reason: classifyFailure(response.status, body),
        latencyMs,
      };
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") || "";
    const parsed = parseReplyJson(rawText);

    return {
      ok: Boolean(parsed),
      provider: "gemini",
      model,
      status: response.status,
      reason: parsed ? null : "malformed_json",
      latencyMs,
      result: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "gemini",
      model,
      status: null,
      reason: error?.name === "AbortError" ? "timeout" : "network_error",
      latencyMs: Date.now() - started,
    };
  } finally {
    timer.clear();
  }
}

async function tryModels(provider, models, caller) {
  const attempts = [];

  for (const model of models) {
    const attempt = await caller(model);
    attempts.push(attempt);

    if (attempt.ok) {
      logAttempt({ ...attempt, fallbackTriggered: attempts.length > 1 });
      return { ok: true, attempt, attempts };
    }

    const canTryNextModel =
      attempt.reason === "model_unavailable" ||
      attempt.reason === "provider_error" ||
      attempt.reason === "timeout" ||
      attempt.reason === "network_error" ||
      attempt.reason === "malformed_json";

    logAttempt({ ...attempt, fallbackTriggered: true });

    if (!canTryNextModel || attempt.reason === "rate_limited" || attempt.reason === "auth_or_permission") {
      break;
    }
  }

  return { ok: false, provider, attempts };
}

async function answerWithAi(systemInstruction, safeHistory, safeMessage, env, forceProvider) {
  const models = getProviderModels(env);
  const messages = buildMessages(systemInstruction, safeHistory, safeMessage);
  const allAttempts = [];

  const providerOrder =
    forceProvider === "gemini"
      ? ["gemini"]
      : forceProvider === "cfai"
        ? ["cfai", "gemini"]
        : ["groq", "cfai", "gemini"];

  for (const provider of providerOrder) {
    let providerResult;

    if (provider === "groq") {
      providerResult = await tryModels("groq", models.groq, (model) => callGroq(model, messages, env));
    } else if (provider === "cfai") {
      providerResult = await tryModels("cfai", models.cfai, (model) => callCloudflareAi(model, messages, env));
    } else {
      providerResult = await tryModels("gemini", models.gemini, (model) =>
        callGemini(model, systemInstruction, safeHistory, safeMessage, env)
      );
    }

    allAttempts.push(...providerResult.attempts);

    if (providerResult.ok) {
      const attempt = providerResult.attempt;
      return {
        ...attempt.result,
        provider: attempt.provider === "gemini" && allAttempts.some((a) => a.provider !== "gemini") ? "gemini-fallback" : attempt.provider,
        model: attempt.model,
        diagnostics: {
          attempts: allAttempts.length,
          cachedTokens: attempt.cachedTokens ?? null,
        },
      };
    }
  }

  console.log(
    JSON.stringify({
      event: "ai_provider_exhausted",
      attempts: allAttempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status || null,
        reason: attempt.reason,
        latencyMs: attempt.latencyMs,
      })),
    })
  );

  return {
    ...FRIENDLY_FALLBACK,
    provider: "fallback",
    diagnostics: { attempts: allAttempts.length },
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
      return jsonResponse({ error: "Invalid JSON body" }, headers, 400);
    }

    const { message, history } = body;

    if (!message || typeof message !== "string") {
      return jsonResponse({ error: "Missing 'message' string in body" }, headers, 400);
    }

    const safeMessage = message.slice(0, MAX_MESSAGE_CHARS);
    const safeHistory = sanitizeHistory(history);
    const staticAnswer = findStaticAnswer(safeMessage);

    if (staticAnswer) {
      return jsonResponse({ ...staticAnswer, provider: "static" }, headers);
    }

    let knowledge;
    try {
      knowledge = await getKnowledge(env);
    } catch (error) {
      return jsonResponse(
        {
          ...FRIENDLY_FALLBACK,
          provider: "fallback",
          diagnostics: { reason: "knowledge_load_failed" },
        },
        headers
      );
    }

    const systemInstruction = SYSTEM_PROMPT_HEADER + knowledge + SYSTEM_PROMPT_FOOTER;
    const url = new URL(request.url);
    const forceProvider = url.searchParams.get("provider");
    const result = await answerWithAi(systemInstruction, safeHistory, safeMessage, env, forceProvider);

    return jsonResponse(result, headers);
  },
};
