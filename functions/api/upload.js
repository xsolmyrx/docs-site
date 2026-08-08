// POST /api/upload
// Body: { title: string, subtitle?: string, pages: string[] }  — pages[i] is the raw
// extracted text of page i+1, produced client-side by pdf.js (see upload UI in app.js).
//
// This Function does NOT parse PDFs — Cloudflare Workers don't run PDF parsing
// libraries well. The browser does extraction; this just chunks plain text and
// writes it to D1. Nothing here is hardcoded to any particular document.

function slugify(title) {
  return title.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document';
}

function cleanText(t) {
  t = t.replace(/(?:\.\s?){5,}/g, ' ');                     // TOC dot-leaders
  t = t.replace(/^\s*Page\s+\d+\s+of\s+\d+\s*$/gim, '');    // generic page-footer
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.replace(/[ \t]+\n/g, '\n');
  return t.split('\n').map(l => l.trim()).filter(Boolean).join('\n').trim();
}

function detectHeading(text) {
  const lines = text.split('\n').slice(0, 6);
  for (const line of lines) {
    const l = line.trim();
    if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(l) && l.length < 90) return l;
    if (/^[A-Z][A-Z0-9 \-,'&]{3,69}$/.test(l) && l === l.toUpperCase()) {
      return l.charAt(0) + l.slice(1).toLowerCase();
    }
  }
  return null;
}

function chunkPages(pages, docId, targetWords = 220) {
  const chunks = [];
  let bufText = [], bufPages = [], bufWords = 0;

  function flush() {
    if (!bufText.length) return;
    const text = bufText.join('\n').trim();
    if (text) {
      chunks.push({
        id: `${docId}-${String(chunks.length + 1).padStart(4, '0')}`,
        doc_id: docId,
        chunk_index: chunks.length,
        page_start: bufPages[0],
        page_end: bufPages[bufPages.length - 1],
        heading: detectHeading(text),
        text: text.slice(0, 1600),
        word_count: text.split(/\s+/).filter(Boolean).length
      });
    }
    bufText = []; bufPages = []; bufWords = 0;
  }

  pages.forEach((raw, i) => {
    const cleaned = cleanText(raw || '');
    if (!cleaned) return;
    const wc = cleaned.split(/\s+/).filter(Boolean).length;
    bufText.push(cleaned);
    bufPages.push(i + 1);
    bufWords += wc;
    if (bufWords >= targetWords) flush();
  });
  flush();
  return chunks;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.docs) {
    return new Response(JSON.stringify({ error: 'D1 database not bound. Check Settings → Bindings for a D1 binding named "docs".' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const title = (body.title || '').trim();
  const subtitle = (body.subtitle || '').trim();
  const pages = Array.isArray(body.pages) ? body.pages : null;

  if (!title) return new Response(JSON.stringify({ error: 'Missing document title.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (!pages || pages.length === 0) return new Response(JSON.stringify({ error: 'No extracted page text provided.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (pages.length > 3000) return new Response(JSON.stringify({ error: 'Document too long (max 3000 pages in this version).' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const uploadedBy = request.headers.get('Cf-Access-Authenticated-User-Email') || 'unknown';

  let docId = slugify(title);
  const existing = await env.docs.prepare('SELECT id FROM documents WHERE id = ?').bind(docId).first();
  if (existing) docId = `${docId}-${Date.now().toString(36)}`;

  const chunks = chunkPages(pages, docId);
  if (chunks.length === 0) {
    return new Response(JSON.stringify({ error: 'No usable text could be extracted from this document. It may be scanned/image-only, which needs OCR first.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const stmts = [
      env.docs.prepare(
        'INSERT INTO documents (id, title, subtitle, pages, uploaded_by) VALUES (?, ?, ?, ?, ?)'
      ).bind(docId, title, subtitle || null, pages.length, uploadedBy)
    ];
    for (const c of chunks) {
      stmts.push(
        env.docs.prepare(
          'INSERT INTO chunks (id, doc_id, chunk_index, page_start, page_end, heading, text, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(c.id, c.doc_id, c.chunk_index, c.page_start, c.page_end, c.heading, c.text, c.word_count)
      );
    }
    await env.docs.batch(stmts);
  } catch (e) {
    return new Response(JSON.stringify({ error: `Database write failed: ${String(e.message || e)}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    doc_id: docId,
    title,
    pages: pages.length,
    chunks: chunks.length,
    uploaded_by: uploadedBy
  }), { headers: { 'Content-Type': 'application/json' } });
}
