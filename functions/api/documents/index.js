// GET /api/documents — list every document currently in the database.

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.docs) {
    return new Response(JSON.stringify({ error: 'D1 database not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const { results } = await env.docs.prepare(
      `SELECT d.id, d.title, d.subtitle, d.pages, d.uploaded_by, d.created_at,
              COUNT(c.id) AS chunk_count
       FROM documents d
       LEFT JOIN chunks c ON c.doc_id = d.id
       GROUP BY d.id
       ORDER BY d.created_at DESC`
    ).all();
    return new Response(JSON.stringify({ documents: results }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
