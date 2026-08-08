// POST /api/generate
// Body: { question: string, mode: "answer" | "story" }
//
// This is the real Phase 2 pipeline:
//  1. Pull the same chunk data the static site already ships (via ASSETS binding —
//     no duplicate data, no separate database).
//  2. Simple keyword retrieval — same idea as the client-side Search tab, just
//     scored across both docs at once to find the best supporting passages.
//  3. Call Claude with only those passages as context, instructed to answer
//     strictly from them and cite page numbers.
//
// Requires an ANTHROPIC_API_KEY secret set on this Pages project
// (Settings → Variables and Secrets → Add → type: Secret).

const DOC_LABELS = {
  telviva: "Telviva Enswitch 4.2",
  queuemetrics: "QueueMetrics 26.01"
};

const STOPWORDS = new Set(("the a an of to in and or for with on at by from is are be this that as it its "
  + "into your you can which will use used using not have has if then than when where each all any also more "
  + "most such other only over under between within without per via what how why does do did doesn't don't")
  .split(/\s+/));

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z][a-z0-9\-]{2,}/g) || []).filter(w => !STOPWORDS.has(w));
}

function scoreChunk(queryWords, chunk) {
  const text = chunk.text.toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    // crude but effective: count occurrences of each query word in the chunk
    const matches = text.split(w).length - 1;
    score += matches;
  }
  return score;
}

async function retrieveTopChunks(env, request, question, topN = 6) {
  const base = new URL(request.url);
  const [tvRes, qmRes] = await Promise.all([
    env.ASSETS.fetch(new URL('/data/telviva.json', base)),
    env.ASSETS.fetch(new URL('/data/queuemetrics.json', base))
  ]);
  const [tv, qm] = await Promise.all([tvRes.json(), qmRes.json()]);

  const queryWords = tokenize(question);
  const pool = [];
  for (const c of tv) pool.push({ doc: 'telviva', chunk: c });
  for (const c of qm) pool.push({ doc: 'queuemetrics', chunk: c });

  const scored = pool
    .map(p => ({ ...p, score: scoreChunk(queryWords, p.chunk) }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score);

  return { scored, tv, qm, queryWords };
}

// For conflict detection, we need guaranteed representation from BOTH docs —
// a plain top-N merge could accidentally return six chunks from one manual
// and none from the other, making conflict-finding impossible.
function balancedTopChunks(scored, tv, qm, queryWords, perDoc = 4) {
  const tvScored = scored.filter(p => p.doc === 'telviva').slice(0, perDoc);
  const qmScored = scored.filter(p => p.doc === 'queuemetrics').slice(0, perDoc);
  return [...tvScored, ...qmScored];
}

function buildContextBlock(results) {
  return results.map((r, i) => {
    const label = DOC_LABELS[r.doc];
    const pages = r.chunk.pages[1] !== r.chunk.pages[0] ? `${r.chunk.pages[0]}–${r.chunk.pages[1]}` : `${r.chunk.pages[0]}`;
    return `[Excerpt ${i + 1} — ${label}, p.${pages}]\n${r.chunk.text}`;
  }).join('\n\n');
}

const SYSTEM_PROMPTS = {
  answer: `You answer questions about two technical manuals: Telviva Enswitch 4.2 (a hosted PBX platform) and QueueMetrics 26.01 (call center analytics that sits on top of Asterisk-based queues). You will be given numbered excerpts pulled from both manuals along with their page numbers. Answer ONLY using information in these excerpts. Cite the source of each claim inline like (Telviva, p.34) or (QueueMetrics, p.516). If the excerpts don't contain enough information to answer, say so plainly rather than guessing. Keep the answer concise — a few sentences to a short paragraph. Write in plain, direct prose.`,
  story: `You turn cross-referenced excerpts from two technical manuals (Telviva Enswitch 4.2, a hosted PBX platform, and QueueMetrics 26.01, call center analytics on Asterisk) into a short, coherent narrative that connects them — showing how something described in one system relates to or is measured by the other. Ground every claim in the provided excerpts and cite page numbers inline like (Telviva, p.34) or (QueueMetrics, p.516). Do not invent details not present in the excerpts. Keep it to one tight paragraph, written in plain, engaging prose — this is meant to help someone understand the full picture quickly, not to pad length.`,
  conflict: `You are a conflict-detection reviewer comparing two technical manuals: Telviva Enswitch 4.2 (a hosted PBX platform) and QueueMetrics 26.01 (call center analytics on Asterisk). You will be given numbered excerpts from both. Your job is NOT to answer a question — it is to actively look for and report any of the following between the two documents on the given topic: (1) outright contradictions, (2) differing definitions of the same term, (3) mismatched terminology that could cause confusion, (4) gaps where one document assumes something the other doesn't establish. For each finding, state it plainly, cite both sides like (Telviva, p.34) vs (QueueMetrics, p.516), and briefly explain the practical consequence of the discrepancy. If you genuinely find no conflict on this topic — the documents agree or are simply complementary — say so directly and explain why they're consistent, do not manufacture a conflict that isn't there. Be concise: 2-4 findings maximum, each 1-2 sentences.`,

  flow: `You reconstruct step-by-step processes from excerpts of two technical manuals (Telviva Enswitch 4.2, a hosted PBX platform, and QueueMetrics 26.01, call center analytics on Asterisk). Given numbered excerpts and a topic, output ONLY valid JSON (no markdown fences, no commentary before or after) matching exactly this shape:
{"title": "short title for the flow", "steps": [{"title": "short step name", "detail": "1-2 sentence explanation grounded in the excerpts", "citation": "Telviva, p.34"}]}
Rules: 3-7 steps, ordered logically. Every step's citation must reference an actual excerpt provided (use the document name and page shown in that excerpt). If a step draws on both documents, pick the most specific citation. If the excerpts don't support a clear sequence for this topic, return {"title": "Not enough information", "steps": []}. Do not invent steps not grounded in the excerpts.`,

  brief: `You are drafting a structured briefing memo from excerpts of two technical manuals (Telviva Enswitch 4.2, a hosted PBX platform, and QueueMetrics 26.01, call center analytics on Asterisk), to help someone quickly get oriented on a topic before deeper review. Given numbered excerpts and a topic, output ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{"title": "topic title", "overview": "2-3 sentence plain-language summary grounded in the excerpts", "definitions": [{"term": "term", "definition": "definition grounded in excerpts", "citation": "Telviva, p.34"}], "crossRefs": [{"point": "how the two documents relate on this topic", "citation": "QueueMetrics, p.516"}], "openQuestions": ["a genuine gap or thing the excerpts don't clarify, phrased as a question"]}
Rules: 1-4 items per array, only include items genuinely grounded in the excerpts. openQuestions should flag real gaps (things a reviewer would still need to check), not filler. Every citation must reference an actual excerpt provided.`,

  devil: `You are a devil's-advocate reviewer. Given numbered excerpts from two technical manuals (Telviva Enswitch 4.2 and QueueMetrics 26.01) and a claim or position someone wants to stress-test, output ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{"claim": "the claim as given", "counterpoints": [{"point": "a genuine counter-argument or complication grounded in the excerpts", "citation": "Telviva, p.34"}], "assessment": "1-2 sentence honest assessment of how strong the claim looks given what's in the excerpts — including saying so if the excerpts actually support the claim well"}
Rules: Find real counterpoints grounded in the excerpts — do not invent weaknesses that aren't there. If the excerpts don't contain anything that meaningfully challenges the claim, say that plainly in the assessment and return an empty counterpoints array rather than manufacturing objections. This is a drafting aid to help someone prepare, not a verdict.`
};

const STRUCTURED_MODES = new Set(['flow', 'brief', 'devil']);

function extractJson(text) {
  // Strip markdown code fences if the model added them despite instructions
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(t);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({
      error: 'This deployment has no ANTHROPIC_API_KEY secret configured yet. Add one in the Cloudflare dashboard under Settings → Variables and Secrets.'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const question = (body.question || '').trim();
  const mode = ['story', 'conflict', 'flow', 'brief', 'devil'].includes(body.mode) ? body.mode : 'answer';
  if (!question) {
    return new Response(JSON.stringify({ error: 'Missing question.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (question.length > 500) {
    return new Response(JSON.stringify({ error: 'Question is too long (max 500 characters).' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const needsBalance = ['conflict', 'brief', 'devil', 'flow'].includes(mode);

  let results;
  try {
    const { scored, tv, qm, queryWords } = await retrieveTopChunks(env, request, question);
    results = needsBalance ? balancedTopChunks(scored, tv, qm, queryWords) : scored.slice(0, 6);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not load document data for retrieval.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  if (results.length === 0) {
    return new Response(JSON.stringify({
      answer: "I couldn't find any passages in Telviva 4.2 or QueueMetrics 26.01 that relate to this question. Try rephrasing, or use a term you've seen in Search / Patch Bay.",
      sources: []
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if ((mode === 'conflict' || mode === 'flow') && (!results.some(r => r.doc === 'telviva') || !results.some(r => r.doc === 'queuemetrics'))) {
    return new Response(JSON.stringify({
      answer: "This topic doesn't have strong enough coverage in both manuals to compare — I found passages in only one of them, so there's nothing to cross-reference. Try a topic you've seen appear in Patch Bay, which is pre-checked for cross-document coverage.",
      sources: results.map(r => ({ doc: r.doc, label: DOC_LABELS[r.doc], pages: r.chunk.pages, heading: r.chunk.heading, id: r.chunk.id }))
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const contextBlock = buildContextBlock(results);
  const userMessage = mode === 'story'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nWrite the connecting narrative for: ${question}`
    : mode === 'conflict'
    ? `Here are relevant excerpts from both manuals:\n\n${contextBlock}\n\nCheck for conflicts on this topic: ${question}`
    : mode === 'flow'
    ? `Here are relevant excerpts from both manuals:\n\n${contextBlock}\n\nReconstruct the step-by-step process for: ${question}`
    : mode === 'brief'
    ? `Here are relevant excerpts from both manuals:\n\n${contextBlock}\n\nDraft the briefing memo for: ${question}`
    : mode === 'devil'
    ? `Here are relevant excerpts from both manuals:\n\n${contextBlock}\n\nStress-test this claim: ${question}`
    : `Here are relevant excerpts:\n\n${contextBlock}\n\nQuestion: ${question}`;

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: STRUCTURED_MODES.has(mode) ? 900 : 500,
        system: SYSTEM_PROMPTS[mode],
        messages: [{ role: 'user', content: userMessage }]
      })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not reach Claude API.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: `Claude API error (${claudeRes.status}): ${errText.slice(0, 300)}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const data = await claudeRes.json();
  const rawText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

  const sources = results.map(r => ({
    doc: r.doc,
    label: DOC_LABELS[r.doc],
    pages: r.chunk.pages,
    heading: r.chunk.heading,
    id: r.chunk.id
  }));

  if (STRUCTURED_MODES.has(mode)) {
    try {
      const structured = extractJson(rawText);
      return new Response(JSON.stringify({ structured, sources }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Claude returned a response that could not be parsed as structured data. Try again — this can happen occasionally.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ answer: rawText, sources }), { headers: { 'Content-Type': 'application/json' } });
}
