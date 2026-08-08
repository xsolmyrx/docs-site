// POST /api/generate
// Body: { question: string, mode: "answer" | "story" | "conflict" | "flow" | "brief" | "devil" }
//
// Retrieval now queries D1's FTS5 full-text index — real relevance ranking
// (BM25), not substring counting — across however many documents actually
// exist. Nothing here assumes any particular document, topic, or domain.
//
// Requires: a D1 binding named "docs" and an ANTHROPIC_API_KEY secret,
// both set on this Pages project under Settings.

const STOPWORDS = new Set(("the a an of to in and or for with on at by from is are be this that as it its "
  + "into your you can which will use used using not have has if then than when where each all any also more "
  + "most such other only over under between within without per via what how why does do did doesn't don't")
  .split(/\s+/));

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z][a-z0-9\-]{2,}/g) || []).filter(w => !STOPWORDS.has(w));
}

async function fetchDocLabels(env) {
  const { results } = await env.docs.prepare('SELECT id, title FROM documents').all();
  const labels = {};
  for (const r of results) labels[r.id] = r.title;
  return labels;
}

async function retrieveTopChunks(env, question) {
  const words = tokenize(question);
  const docLabels = await fetchDocLabels(env);
  if (words.length === 0) return { scored: [], docLabels };

  const ftsQuery = words.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');

  let results;
  try {
    const res = await env.docs.prepare(
      `SELECT c.id, c.doc_id, c.page_start, c.page_end, c.heading, c.text
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts)
       LIMIT 40`
    ).bind(ftsQuery).all();
    results = res.results;
  } catch (e) {
    return { scored: [], docLabels };
  }

  const scored = results.map(r => ({
    doc: r.doc_id,
    chunk: { id: r.id, pages: [r.page_start, r.page_end], heading: r.heading, text: r.text }
  }));

  return { scored, docLabels };
}

function balancedTopChunks(scored, perDoc = 4, maxDocs = 5) {
  const byDoc = {};
  const order = [];
  for (const s of scored) {
    if (!byDoc[s.doc]) { byDoc[s.doc] = []; order.push(s.doc); }
    if (byDoc[s.doc].length < perDoc) byDoc[s.doc].push(s);
  }
  const result = [];
  for (const id of order.slice(0, maxDocs)) result.push(...byDoc[id]);
  return result;
}

function buildContextBlock(results, docLabels) {
  return results.map((r, i) => {
    const label = docLabels[r.doc] || r.doc;
    const pages = r.chunk.pages[1] !== r.chunk.pages[0] ? `${r.chunk.pages[0]}–${r.chunk.pages[1]}` : `${r.chunk.pages[0]}`;
    return `[Excerpt ${i + 1} — ${label}, p.${pages}]\n${r.chunk.text}`;
  }).join('\n\n');
}

const SYSTEM_PROMPTS = {
  answer: `You answer questions using excerpts retrieved from a set of uploaded documents. You will be given numbered excerpts along with the document title and page number each came from. Answer ONLY using information in these excerpts. Cite the source of each claim inline like (Document Title, p.34). If the excerpts don't contain enough information to answer, say so plainly rather than guessing. Keep the answer concise — a few sentences to a short paragraph. Write in plain, direct prose.`,

  story: `You turn cross-referenced excerpts from a set of uploaded documents into a short, coherent narrative that connects them — showing how something described in one document relates to another. Ground every claim in the provided excerpts and cite them inline like (Document Title, p.34). Do not invent details not present in the excerpts. Keep it to one tight paragraph, written in plain, engaging prose.`,

  conflict: `You are a conflict-detection reviewer comparing excerpts from a set of uploaded documents. Your job is NOT to answer a question — it is to actively look for and report: (1) outright contradictions between documents, (2) differing definitions of the same term or fact, (3) mismatched terminology that could cause confusion, (4) gaps where one document assumes something another doesn't establish. For each finding, state it plainly, cite both sides like (Document A, p.34) vs (Document B, p.12), and briefly explain the practical consequence. If you genuinely find no conflict on this topic, say so directly and explain why the documents are consistent — do not manufacture a conflict that isn't there. Be concise: 2-4 findings maximum, each 1-2 sentences.`,

  flow: `You reconstruct step-by-step processes from excerpts of a set of uploaded documents. Given numbered excerpts and a topic, output ONLY valid JSON (no markdown fences, no commentary before or after) matching exactly this shape:
{"title": "short title for the flow", "steps": [{"title": "short step name", "detail": "1-2 sentence explanation grounded in the excerpts", "citation": "Document Title, p.34"}]}
Rules: 3-7 steps, ordered logically. Every step's citation must reference an actual excerpt provided (use the document title and page shown in that excerpt). If the excerpts don't support a clear sequence for this topic, return {"title": "Not enough information", "steps": []}. Do not invent steps not grounded in the excerpts.`,

  brief: `You are drafting a structured briefing memo from excerpts of a set of uploaded documents, to help someone quickly get oriented on a topic before deeper review. Given numbered excerpts and a topic, output ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{"title": "topic title", "overview": "2-3 sentence plain-language summary grounded in the excerpts", "definitions": [{"term": "term", "definition": "definition grounded in excerpts", "citation": "Document Title, p.34"}], "crossRefs": [{"point": "how documents relate on this topic", "citation": "Document Title, p.12"}], "openQuestions": ["a genuine gap or thing the excerpts don't clarify, phrased as a question"]}
Rules: 1-4 items per array, only include items genuinely grounded in the excerpts. openQuestions should flag real gaps a reviewer would need to check, not filler. Every citation must reference an actual excerpt provided.`,

  devil: `You are a devil's-advocate reviewer. Given numbered excerpts from a set of uploaded documents and a claim or position someone wants to stress-test, output ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{"claim": "the claim as given", "counterpoints": [{"point": "a genuine counter-argument or complication grounded in the excerpts", "citation": "Document Title, p.34"}], "assessment": "1-2 sentence honest assessment of how strong the claim looks given what's in the excerpts — including saying so if the excerpts actually support the claim well"}
Rules: Find real counterpoints grounded in the excerpts — do not invent weaknesses that aren't there. If the excerpts don't contain anything that meaningfully challenges the claim, say that plainly in the assessment and return an empty counterpoints array. This is a drafting aid to help someone prepare, not a verdict.`
};

const STRUCTURED_MODES = new Set(['flow', 'brief', 'devil']);

function extractJson(text) {
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
  if (!env.docs) {
    return new Response(JSON.stringify({ error: 'D1 database not bound (expected binding name "docs").' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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

  let results, docLabels;
  try {
    const r = await retrieveTopChunks(env, question);
    docLabels = r.docLabels;
    results = needsBalance ? balancedTopChunks(r.scored) : r.scored.slice(0, 6);
  } catch (e) {
    return new Response(JSON.stringify({ error: `Retrieval failed: ${String(e.message || e)}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  if (results.length === 0) {
    return new Response(JSON.stringify({
      answer: Object.keys(docLabels || {}).length === 0
        ? "No documents have been uploaded yet — head to the Upload tab first."
        : "I couldn't find any passages relating to this question in the uploaded documents. Try rephrasing, or a term you've seen in Search.",
      sources: []
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  if ((mode === 'conflict' || mode === 'flow') && new Set(results.map(r => r.doc)).size < 2) {
    return new Response(JSON.stringify({
      answer: "This topic doesn't have strong enough coverage across multiple documents to cross-reference — matches were only found in one document. This mode needs the topic to appear in at least two.",
      sources: results.map(r => ({ doc: r.doc, label: docLabels[r.doc] || r.doc, pages: r.chunk.pages, heading: r.chunk.heading, id: r.chunk.id }))
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  const contextBlock = buildContextBlock(results, docLabels);
  const userMessage = mode === 'story'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nWrite the connecting narrative for: ${question}`
    : mode === 'conflict'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nCheck for conflicts on this topic: ${question}`
    : mode === 'flow'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nReconstruct the step-by-step process for: ${question}`
    : mode === 'brief'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nDraft the briefing memo for: ${question}`
    : mode === 'devil'
    ? `Here are relevant excerpts:\n\n${contextBlock}\n\nStress-test this claim: ${question}`
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
    label: docLabels[r.doc] || r.doc,
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
