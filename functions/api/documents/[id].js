// DELETE /api/documents/:id — removes a document and everything tied to it.
// Explicit cascade rather than relying on SQLite's ON DELETE CASCADE, since
// D1 doesn't enable foreign-key enforcement by default per-connection.

export async function onRequestDelete(context) {
  const { env, params } = context;
  const docId = params.id;
  if (!env.docs) {
    return new Response(JSON.stringify({ error: 'D1 database not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  if (!docId) {
    return new Response(JSON.stringify({ error: 'Missing document id.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const doc = await env.docs.prepare('SELECT id FROM documents WHERE id = ?').bind(docId).first();
    if (!doc) {
      return new Response(JSON.stringify({ error: 'Document not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Best-effort R2 cleanup for any page images tied to this document.
    if (env['docs-r2']) {
      try {
        const { results: imgs } = await env.docs.prepare('SELECT r2_key FROM images WHERE doc_id = ?').bind(docId).all();
        for (const img of imgs) {
          await env['docs-r2'].delete(img.r2_key);
        }
      } catch (e) {
        // Non-fatal — proceed with DB cleanup even if R2 cleanup partially fails.
      }
    }

    await env.docs.batch([
      env.docs.prepare('DELETE FROM images WHERE doc_id = ?').bind(docId),
      env.docs.prepare('DELETE FROM chunks WHERE doc_id = ?').bind(docId),
      env.docs.prepare('DELETE FROM documents WHERE id = ?').bind(docId)
    ]);

    return new Response(JSON.stringify({ deleted: docId }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
