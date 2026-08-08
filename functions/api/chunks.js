// GET /api/chunks?doc=ID — all chunks for one document, in page order.

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const docId = url.searchParams.get('doc');

  if (!env.docs) {
    return new Response(JSON.stringify({ error: 'D1 database not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (!docId) {
    return new Response(JSON.stringify({ error: 'Missing ?doc= parameter.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const { results } = await env.docs.prepare(
      'SELECT id, doc_id, page_start, page_end, heading, text, word_count FROM chunks WHERE doc_id = ? ORDER BY chunk_index ASC'
    ).bind(docId).all();

    const chunks = results.map(r => ({
      id: r.id,
      doc: r.doc_id,
      pages: [r.page_start, r.page_end],
      heading: r.heading,
      text: r.text
    }));

    return new Response(JSON.stringify({ chunks }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
