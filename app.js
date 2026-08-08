(function(){
  "use strict";

  const state = {
    docs: {}, // id -> {meta, chunks}
    crossref: [],
    searchDocFilter: "all",
    chunkDoc: null,
    activeTerm: null,
    binder: []
  };

  const DOC_META = {}; // populated dynamically from /api/documents — no document is ever hardcoded

  // ---------- Data loading ----------
  // This project starts with an empty document set. Everything here is
  // populated from D1 via /api/documents once real PDFs are uploaded —
  // no static placeholder content ships with this codebase.
  async function loadData(){
    state.docs = {};
    state.crossref = [];
    state.images = {};
    state.graph = { nodes: [], edges: [] };

    try{
      const res = await fetch('/api/documents');
      const data = await res.json();
      if(res.ok && data.documents){
        await Promise.all(data.documents.map(async d => {
          DOC_META[d.id] = { title: d.title, sub: d.subtitle || '', desc: d.subtitle || '' };
          let chunks = [];
          try{
            const cRes = await fetch(`/api/chunks?doc=${encodeURIComponent(d.id)}`);
            const cData = await cRes.json();
            if(cRes.ok && cData.chunks) chunks = cData.chunks;
          } catch(e){ console.error(`Failed to load chunks for ${d.id}:`, e); }
          state.docs[d.id] = { meta: DOC_META[d.id], chunks, pages: d.pages };
        }));
      } else if(!res.ok || data.error){
        console.error('/api/documents returned an error:', data.error || res.status);
      }
    } catch(e){
      console.error('Could not reach /api/documents — is the D1 binding configured?', e);
    }

    const docIds = Object.keys(state.docs);
    if(docIds.length) state.chunkDoc = docIds[0];
  }

  // Find the best associated screenshot for a chunk, checking every page it spans.
  function findImageForChunk(doc, chunk){
    const manifest = state.images && state.images[doc];
    if(!manifest) return null;
    for(let p = chunk.pages[0]; p <= chunk.pages[1]; p++){
      if(manifest[String(p)]) return { src: manifest[String(p)], page: p };
    }
    return null;
  }

  function imageBlockHtml(doc, chunk, docLabel){
    const img = findImageForChunk(doc, chunk);
    if(!img) return '';
    return `<figure class="chunk-image">
      <img src="${img.src}" alt="Screenshot from ${escapeHtml(docLabel)}, page ${img.page}" loading="lazy">
      <figcaption>Screenshot &middot; ${escapeHtml(docLabel)} p.${img.page}</figcaption>
    </figure>`;
  }

  function wordCount(chunks){
    return chunks.reduce((sum, c) => sum + c.text.split(/\s+/).filter(Boolean).length, 0);
  }
  function maxPage(chunks){
    return chunks.reduce((m, c) => Math.max(m, c.pages[1]), 0);
  }

  // ---------- Tabs ----------
  function initTabs(){
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + t.dataset.view).classList.add('active');
      });
    });
  }

  // ---------- Hero ----------
  function renderHeroStats(){
    const allDocs = Object.values(state.docs);
    const totalChunks = allDocs.reduce((sum, d) => sum + d.chunks.length, 0);
    const totalWords = allDocs.reduce((sum, d) => sum + wordCount(d.chunks), 0);
    const totalImages = Object.values(state.images || {}).reduce((sum, m) => sum + Object.keys(m || {}).length, 0);
    const el = document.getElementById('hero-stats');
    el.innerHTML = `
      <div class="hero-stat"><span class="num">${allDocs.length}</span><span class="lbl">Documents</span></div>
      <div class="hero-stat"><span class="num">${totalChunks}</span><span class="lbl">Chunks</span></div>
      <div class="hero-stat"><span class="num">${totalWords.toLocaleString()}</span><span class="lbl">Words indexed</span></div>
      <div class="hero-stat"><span class="num">${totalImages}</span><span class="lbl">Screenshots extracted</span></div>
      <div class="hero-stat"><span class="num">${state.crossref.length}</span><span class="lbl">Cross-refs found</span></div>
    `;
  }

  function renderHeroPatchbay(){
    const svg = document.getElementById('hero-patchbay');
    const leftX = 60, rightX = 400, top = 30, gap = 40;
    const n = 6;
    let jacks = '';
    let cables = '';
    for(let i=0;i<n;i++){
      const y = top + i*gap;
      const ry = top + ((i + 2) % n) * gap;
      jacks += `<circle cx="${leftX}" cy="${y}" r="5" fill="var(--brass)"/>`;
      jacks += `<circle cx="${rightX}" cy="${ry}" r="5" fill="var(--brass)"/>`;
      const midx = (leftX+rightX)/2;
      cables += `<path d="M${leftX},${y} C${midx},${y} ${midx},${ry} ${rightX},${ry}"
                   fill="none" stroke="var(--line)" stroke-width="1.5" class="ambient-cable" style="animation-delay:${i*0.4}s"/>`;
    }
    svg.innerHTML = `
      <rect x="20" y="10" width="80" height="${top+ (n-1)*gap - 10 + 20}" rx="6" fill="var(--panel-2)" stroke="var(--line)"/>
      <rect x="360" y="10" width="80" height="${top+ (n-1)*gap - 10 + 20}" rx="6" fill="var(--panel-2)" stroke="var(--line)"/>
      ${cables}
      ${jacks}
    `;
    // simple ambient pulse via CSS injected inline (kept minimal, respects reduced-motion via global rule)
    const style = document.createElement('style');
    style.textContent = `.ambient-cable{stroke-dasharray:6 10; animation:dash 6s linear infinite;} @keyframes dash{to{stroke-dashoffset:-160;}}`;
    document.head.appendChild(style);
  }

  // ---------- Library ----------
  function renderLibrary(){
    const el = document.getElementById('library-cards');
    el.innerHTML = Object.entries(state.docs).map(([id, d]) => {
      const words = wordCount(d.chunks);
      const pages = maxPage(d.chunks);
      const imgCount = Object.keys(state.images[id] || {}).length;
      return `
        <div class="doc-card">
          <p class="doc-title">${d.meta.title}</p>
          <p class="doc-sub">${d.meta.sub}</p>
          <div class="doc-stats">
            <div><span class="num">${pages}</span><span class="lbl">Pages</span></div>
            <div><span class="num">${d.chunks.length}</span><span class="lbl">Chunks</span></div>
            <div><span class="num">${words.toLocaleString()}</span><span class="lbl">Words</span></div>
            <div><span class="num">${imgCount}</span><span class="lbl">Screenshots</span></div>
          </div>
          <p class="doc-desc">${d.meta.desc}</p>
        </div>
      `;
    }).join('');
  }

  // ---------- Search ----------
  function initSearch(){
    const input = document.getElementById('search-input');
    renderSearchFilters();
    input.addEventListener('input', () => runSearch(input.value));
  }

  function renderSearchFilters(){
    const el = document.getElementById('search-filters');
    const docIds = Object.keys(state.docs);
    el.innerHTML = `<button class="filter-chip active" data-doc="all">All documents</button>`
      + docIds.map(id => `<button class="filter-chip" data-doc="${escapeHtml(id)}">${escapeHtml(DOC_META[id].title)}</button>`).join('');

    const chips = el.querySelectorAll('.filter-chip');
    chips.forEach(c => c.addEventListener('click', () => {
      chips.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      state.searchDocFilter = c.dataset.doc;
      runSearch(document.getElementById('search-input').value);
    }));

    document.getElementById('search-meta').textContent = docIds.length
      ? `Search across ${docIds.length} document${docIds.length===1?'':'s'}.`
      : 'Upload a document to start searching.';
  }

  function escapeHtml(s){
    return s.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  }

  function runSearch(query){
    const meta = document.getElementById('search-meta');
    const results = document.getElementById('search-results');
    query = (query || '').trim();
    if(!query){
      const docIds = Object.keys(state.docs);
      meta.textContent = docIds.length
        ? `Search across ${docIds.length} document${docIds.length===1?'':'s'}.`
        : 'Upload a document to start searching.';
      results.innerHTML = '';
      return;
    }
    const q = query.toLowerCase();
    let pool = [];
    Object.entries(state.docs).forEach(([id, d]) => {
      if(state.searchDocFilter !== 'all' && state.searchDocFilter !== id) return;
      d.chunks.forEach(c => {
        const idx = c.text.toLowerCase().indexOf(q);
        if(idx !== -1) pool.push({doc: id, chunk: c, idx});
      });
    });
    meta.textContent = `${pool.length} match${pool.length===1?'':'es'} for "${query}"${pool.length ? ' — click a result to read the full passage' : ''}`;
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'ig');

    results.innerHTML = pool.slice(0, 40).map(({doc, chunk, idx}, i) => {
      const start = Math.max(0, idx - 80);
      const end = Math.min(chunk.text.length, idx + q.length + 120);
      let snippet = escapeHtml(chunk.text.slice(start, end)).replace(re, '<mark>$1</mark>');
      const label = DOC_META[doc].title;
      return `
        <div class="result-item" data-rid="${i}" data-doc="${doc}" data-cid="${chunk.id}" tabindex="0" role="button" aria-expanded="false">
          <div class="result-meta">
            <span class="badge">${label}</span>
            <span class="pageref">p. ${chunk.pages[0]}${chunk.pages[1]!==chunk.pages[0] ? '–'+chunk.pages[1] : ''}</span>
            <span class="expand-hint">Click to expand ▾</span>
          </div>
          ${chunk.heading ? `<p class="result-heading">${escapeHtml(chunk.heading)}</p>` : ''}
          <p class="result-text">&hellip;${snippet}&hellip;</p>
        </div>
      `;
    }).join('') || '<p class="patch-hint">No matches. Try a shorter or different term.</p>';

    results.querySelectorAll('.result-item').forEach(item => {
      item.addEventListener('click', () => toggleResultExpand(item, re));
      item.addEventListener('keydown', e => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleResultExpand(item, re); }
      });
    });
  }

  function toggleResultExpand(item, highlightRe){
    const isOpen = item.classList.contains('expanded');
    if(isOpen){
      item.classList.remove('expanded');
      item.setAttribute('aria-expanded', 'false');
      item.querySelector('.expand-hint').textContent = 'Click to expand ▾';
      item.querySelector('.result-full')?.remove();
      return;
    }
    const doc = item.dataset.doc, cid = item.dataset.cid;
    const chunk = state.docs[doc].chunks.find(c => c.id === cid);
    if(!chunk) return;
    let full = escapeHtml(chunk.text).replace(highlightRe, '<mark>$1</mark>');
    let full3 = item.querySelector('.result-full');
    if(!full3){
      full3 = document.createElement('div');
      full3.className = 'result-full';
      item.appendChild(full3);
    }
    full3.innerHTML = `<p class="ch-pages">Full chunk ${chunk.id} &middot; ${chunk.text.split(/\s+/).filter(Boolean).length} words</p>${imageBlockHtml(doc, chunk, DOC_META[doc].title)}<p>${full}</p>${binderButtonHtml(doc, chunk.id)}`;
    wireBinderButtons(full3);
    item.classList.add('expanded');
    item.setAttribute('aria-expanded', 'true');
    item.querySelector('.expand-hint').textContent = 'Click to collapse ▴';
  }

  // ---------- Patch bay ----------
  const PATCHBAY_STOP = new Set(("the a an of to in and or for with on at by from is are be this that as it its "
    + "into your you can which will use used using not have has if then than when where each all any also more "
    + "most such other only over under between within without per via one two three these those their they them "
    + "our we may might should would could must page click select field name type value default system following "
    + "section screen shown below example figure information time date fields option options settings menu tab "
    + "window view number numbers current text list report reports data file server").split(/\s+/));

  function termFreqByChunk(chunks){
    const freq = {};
    for(const c of chunks){
      const seen = new Set();
      const words = (c.text.toLowerCase().match(/[a-z][a-z0-9\-]{2,}/g) || []);
      for(const w of words){
        if(PATCHBAY_STOP.has(w) || w.length <= 3) continue;
        seen.add(w);
      }
      for(const w of seen) freq[w] = (freq[w] || 0) + 1;
    }
    return freq;
  }

  function bestChunkForTerm(chunks, term){
    let best = null, bestScore = 0;
    const re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\w*\\b', 'gi');
    for(const c of chunks){
      const score = (c.text.match(re) || []).length;
      if(score > bestScore){ bestScore = score; best = c; }
    }
    return best;
  }

  function computeCrossRef(docA, docB, topN = 10){
    const chunksA = state.docs[docA].chunks, chunksB = state.docs[docB].chunks;
    const freqA = termFreqByChunk(chunksA), freqB = termFreqByChunk(chunksB);
    const shared = Object.keys(freqA).filter(w => freqB[w] && freqA[w] >= 2 && freqB[w] >= 2);
    shared.sort((a,b) => (freqB[b]+freqA[b]) - (freqB[a]+freqA[a]));
    return shared.slice(0, topN).map(term => {
      const cA = bestChunkForTerm(chunksA, term), cB = bestChunkForTerm(chunksB, term);
      if(!cA || !cB) return null;
      return { term, [docA]: cA, [docB]: cB };
    }).filter(Boolean);
  }

  function initPatchbay(){
    const selA = document.getElementById('patchbay-doc-a');
    const selB = document.getElementById('patchbay-doc-b');
    const docIds = Object.keys(state.docs);
    const opts = docIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(DOC_META[id].title)}</option>`).join('');
    selA.innerHTML = '<option value="">Choose a document…</option>' + opts;
    selB.innerHTML = '<option value="">Choose a document…</option>' + opts;
    selA.addEventListener('change', renderPatchbay);
    selB.addEventListener('change', renderPatchbay);
    if(docIds.length >= 2){ selA.value = docIds[0]; selB.value = docIds[1]; renderPatchbay(); }
    window.addEventListener('resize', debounce(drawCables, 150));
  }

  function renderPatchbay(){
    const docA = document.getElementById('patchbay-doc-a').value;
    const docB = document.getElementById('patchbay-doc-b').value;
    const wrap = document.getElementById('patchbay-wrap');
    const detail = document.getElementById('patch-detail');

    if(!docA || !docB || docA === docB){
      wrap.hidden = true;
      detail.innerHTML = docA && docA === docB
        ? '<p class="patch-hint">Choose two different documents to compare.</p>'
        : '<p class="patch-hint">Choose two documents above to find terms they share.</p>';
      return;
    }

    const crossref = computeCrossRef(docA, docB);
    state.patchbayCrossref = crossref;
    state.patchbayDocs = [docA, docB];

    if(crossref.length === 0){
      wrap.hidden = true;
      detail.innerHTML = '<p class="patch-hint">No strongly shared terms found between these two documents.</p>';
      return;
    }

    wrap.hidden = false;
    document.getElementById('patchbay-label-a').textContent = DOC_META[docA].title;
    document.getElementById('patchbay-label-b').textContent = DOC_META[docB].title;

    const jacksA = document.getElementById('jacks-a');
    const jacksB = document.getElementById('jacks-b');
    jacksA.innerHTML = crossref.map(c => jackHtml(c.term)).join('');
    jacksB.innerHTML = crossref.map(c => jackHtml(c.term)).join('');

    document.querySelectorAll('.jack').forEach(j => {
      j.addEventListener('click', () => selectTerm(j.dataset.term));
      j.addEventListener('mouseenter', () => highlightCable(j.dataset.term, true));
      j.addEventListener('mouseleave', () => highlightCable(j.dataset.term, false));
    });

    detail.innerHTML = '<p class="patch-hint">Select a term above to see the matched passage from each document, side by side.</p>';
    drawCables();
  }

  function jackHtml(term){
    return `<div class="jack" data-term="${escapeHtml(term)}"><span class="dot"></span><span class="jack-label">${escapeHtml(term)}</span></div>`;
  }

  function drawCables(){
    const svg = document.getElementById('cable-svg');
    const jacksA = document.getElementById('jacks-a');
    const jacksB = document.getElementById('jacks-b');
    if(!jacksA || !jacksB) return;
    const aJacks = [...jacksA.children], bJacks = [...jacksB.children];
    const wrap = document.querySelector('.patchbay-wrap');
    if(!wrap || aJacks.length === 0) return;
    const svgRect = svg.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${svgRect.width || 120} ${svgRect.height || 400}`);

    let paths = '';
    (state.patchbayCrossref || []).forEach((c, i) => {
      if(!aJacks[i] || !bJacks[i]) return;
      const l = aJacks[i].getBoundingClientRect();
      const r = bJacks[i].getBoundingClientRect();
      const y1 = l.top + l.height/2 - svgRect.top;
      const y2 = r.top + r.height/2 - svgRect.top;
      const w = svgRect.width || 120;
      const midx = w/2;
      paths += `<path class="cable-path" data-term="${escapeHtml(c.term)}" d="M0,${y1} C${midx},${y1} ${midx},${y2} ${w},${y2}"/>`;
    });
    svg.innerHTML = paths;
  }

  function highlightCable(term, on){
    const path = document.querySelector(`.cable-path[data-term="${CSS.escape(term)}"]`);
    if(path) path.classList.toggle('active', on);
  }

  function selectTerm(term){
    state.activeTerm = term;
    document.querySelectorAll('.jack').forEach(j => j.classList.toggle('active', j.dataset.term === term));
    document.querySelectorAll('.cable-path').forEach(p => p.classList.toggle('active', p.dataset.term === term));
    const entry = (state.patchbayCrossref || []).find(c => c.term === term);
    if(!entry) return;
    const [docA, docB] = state.patchbayDocs;
    const detail = document.getElementById('patch-detail');

    function colHtml(doc){
      const chunk = entry[doc];
      const pages = chunk.pages[1] !== chunk.pages[0] ? `${chunk.pages[0]}–${chunk.pages[1]}` : `${chunk.pages[0]}`;
      const excerpt = chunk.text.slice(0, 220);
      return `
        <div class="patch-compare-col" data-doc="${escapeHtml(doc)}" data-cid="${escapeHtml(chunk.id)}">
          <h4>${escapeHtml(DOC_META[doc].title)}</h4>
          <span class="pageref">p. ${pages}${chunk.heading ? ' &middot; ' + escapeHtml(chunk.heading) : ''}</span>
          <p class="patch-excerpt">&hellip;${escapeHtml(excerpt)}&hellip;</p>
          <button class="btn-expand" type="button">Show full chunk ▾</button>
        </div>
      `;
    }

    detail.innerHTML = `<div class="patch-compare">${colHtml(docA)}${colHtml(docB)}</div>`;
    detail.querySelectorAll('.btn-expand').forEach(btn => {
      btn.addEventListener('click', () => {
        const col = btn.closest('.patch-compare-col');
        const doc = col.dataset.doc, cid = col.dataset.cid;
        const isOpen = col.classList.contains('expanded');
        if(isOpen){
          col.classList.remove('expanded');
          col.querySelector('.patch-full')?.remove();
          btn.textContent = 'Show full chunk ▾';
          return;
        }
        const chunk = state.docs[doc].chunks.find(c => c.id === cid);
        if(!chunk) return;
        const full = document.createElement('div');
        full.className = 'patch-full';
        full.innerHTML = `${imageBlockHtml(doc, chunk, DOC_META[doc].title)}<p>${escapeHtml(chunk.text)}</p>${binderButtonHtml(doc, chunk.id)}`;
        wireBinderButtons(full);
        col.insertBefore(full, btn);
        col.classList.add('expanded');
        btn.textContent = 'Hide full chunk ▴';
      });
    });
  }

  function debounce(fn, ms){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---------- Chunk explorer ----------
  function initChunkExplorer(){
    renderChunkDocSelector();
    renderChunkStrip();
  }

  function renderChunkDocSelector(){
    const el = document.getElementById('chunk-doc-select');
    const docIds = Object.keys(state.docs);
    if(docIds.length === 0){
      el.innerHTML = '';
      return;
    }
    el.innerHTML = docIds.map(id => `
      <button class="filter-chip${id === state.chunkDoc ? ' active' : ''}" data-doc="${escapeHtml(id)}">
        ${escapeHtml(DOC_META[id].title)} &middot; <span>${state.docs[id].chunks.length}</span> chunks
      </button>
    `).join('');
    el.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        el.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.chunkDoc = chip.dataset.doc;
        renderChunkStrip();
      });
    });
  }

  function renderChunkStrip(){
    const strip = document.getElementById('chunk-strip');
    const detail = document.getElementById('chunk-detail');
    const statsEl = document.getElementById('chunk-stats');

    if(!state.chunkDoc || !state.docs[state.chunkDoc]){
      strip.innerHTML = '';
      statsEl.innerHTML = '';
      detail.innerHTML = '<p class="patch-hint">Nothing uploaded yet — head to the Upload tab to add a document.</p>';
      return;
    }

    const chunks = state.docs[state.chunkDoc].chunks;
    strip.innerHTML = chunks.map((c, i) => {
      const size = c.text.split(/\s+/).filter(Boolean).length;
      const grow = Math.max(1, Math.round(size / 20));
      return `<div class="chunk-seg" data-idx="${i}" style="flex-grow:${grow}" title="p.${c.pages[0]}"></div>`;
    }).join('');
    strip.querySelectorAll('.chunk-seg').forEach(seg => {
      seg.addEventListener('mouseenter', () => showChunkDetail(parseInt(seg.dataset.idx)));
      seg.addEventListener('click', () => showChunkDetail(parseInt(seg.dataset.idx)));
    });

    if(chunks.length === 0){
      statsEl.innerHTML = '';
      detail.innerHTML = '<p class="patch-hint">This document has no chunks (extraction may have failed).</p>';
      return;
    }

    const words = chunks.map(c => c.text.split(/\s+/).filter(Boolean).length);
    const avg = Math.round(words.reduce((a,b)=>a+b,0) / words.length);
    statsEl.innerHTML = `
      <div><span class="num">${chunks.length}</span><span class="lbl">Total chunks</span></div>
      <div><span class="num">${avg}</span><span class="lbl">Avg words / chunk</span></div>
      <div><span class="num">${Math.max(...words)}</span><span class="lbl">Largest chunk</span></div>
      <div><span class="num">${maxPage(chunks)}</span><span class="lbl">Pages covered</span></div>
    `;
    showChunkDetail(0);
  }

  function showChunkDetail(idx){
    document.querySelectorAll('.chunk-seg').forEach(s => s.classList.toggle('active', parseInt(s.dataset.idx) === idx));
    const chunks = state.docs[state.chunkDoc].chunks;
    const c = chunks[idx];
    const detail = document.getElementById('chunk-detail');
    // Full stored chunk text (no artificial cutoff) — scrolls internally if long, see CSS.
    detail.innerHTML = `
      ${c.heading ? `<p class="ch-heading">${escapeHtml(c.heading)}</p>` : `<p class="ch-heading">Chunk ${c.id}</p>`}
      <span class="ch-pages">p. ${c.pages[0]}${c.pages[1]!==c.pages[0] ? '–'+c.pages[1] : ''} &middot; ${c.text.split(/\s+/).filter(Boolean).length} words &middot; id ${c.id}</span>
      ${imageBlockHtml(state.chunkDoc, c, DOC_META[state.chunkDoc].title)}
      <div class="ch-text-scroll"><p class="ch-text">${escapeHtml(c.text)}</p></div>
      ${binderButtonHtml(state.chunkDoc, c.id)}
    `;
    wireBinderButtons(detail);
  }

  // ---------- Concept Graph ----------
  function renderConceptGraph(){
    const svg = document.getElementById('concept-svg');
    const { nodes, edges } = state.graph;

    if(!nodes || nodes.length === 0){
      svg.innerHTML = '';
      document.getElementById('graph-detail').innerHTML =
        '<p class="patch-hint">No concept graph yet — this is computed after documents are uploaded. (Not yet wired up in this version; coming in a follow-up.)</p>';
      return;
    }

    const nodeById = {};
    nodes.forEach(n => nodeById[n.id] = n);

    const maxSize = Math.max(...nodes.map(n => n.size));
    const radius = n => 8 + (n.size / maxSize) * 20;

    let edgeSvg = '';
    edges.forEach(e => {
      const a = nodeById[e.a], b = nodeById[e.b];
      if(!a || !b) return;
      const w = 0.6 + Math.min(e.w, 8) * 0.35;
      edgeSvg += `<line class="graph-edge ${e.cross ? 'edge-cross' : 'edge-same'}" data-a="${e.a}" data-b="${e.b}"
        x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${w}"/>`;
    });

    let nodeSvg = '';
    nodes.forEach(n => {
      const r = radius(n);
      nodeSvg += `<g class="graph-node kind-${n.kind}" data-id="${n.id}" tabindex="0" role="button" transform="translate(${n.x},${n.y})">
        <circle r="${r}" class="node-circle"></circle>
        <text class="node-label" y="${r + 13}" text-anchor="middle">${escapeHtml(n.id)}</text>
      </g>`;
    });

    svg.innerHTML = `<g class="edges-layer">${edgeSvg}</g><g class="nodes-layer">${nodeSvg}</g>`;

    svg.querySelectorAll('.graph-node').forEach(g => {
      g.addEventListener('click', () => selectConceptNode(g.dataset.id));
      g.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); selectConceptNode(g.dataset.id); } });
    });
  }

  function selectConceptNode(term){
    const svg = document.getElementById('concept-svg');
    svg.querySelectorAll('.graph-node').forEach(g => g.classList.toggle('active', g.dataset.id === term));
    svg.querySelectorAll('.graph-edge').forEach(l => {
      l.classList.toggle('active', l.dataset.a === term || l.dataset.b === term);
    });

    // Find every chunk in either doc that actually contains this term (whole word).
    const re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\w*\\b', 'i');
    const hits = [];
    Object.entries(state.docs).forEach(([doc, d]) => {
      d.chunks.forEach(c => { if(re.test(c.text)) hits.push({ doc, chunk: c }); });
    });

    const detail = document.getElementById('graph-detail');
    const byDoc = {};
    hits.forEach(h => { byDoc[h.doc] = (byDoc[h.doc] || 0) + 1; });
    const countLabel = Object.entries(byDoc).map(([doc, n]) => `${n} in ${DOC_META[doc] ? DOC_META[doc].title : doc}`).join(', ');
    const highlightRe = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\w*)', 'ig');

    detail.innerHTML = `
      <p class="graph-detail-head">"${escapeHtml(term)}" &middot; ${hits.length} passage${hits.length===1?'':'s'}${countLabel ? ' (' + escapeHtml(countLabel) + ')' : ''}</p>
      <div class="search-results" id="graph-results"></div>
    `;
    const resultsEl = document.getElementById('graph-results');
    resultsEl.innerHTML = hits.slice(0, 20).map((h, i) => {
      const c = h.chunk;
      const snippet = escapeHtml(c.text.slice(0, 200)).replace(highlightRe, '<mark>$1</mark>');
      return `
        <div class="result-item" data-doc="${h.doc}" data-cid="${c.id}" tabindex="0" role="button" aria-expanded="false">
          <div class="result-meta">
            <span class="badge">${DOC_META[h.doc].title}</span>
            <span class="pageref">p. ${c.pages[0]}${c.pages[1]!==c.pages[0] ? '–'+c.pages[1] : ''}</span>
            <span class="expand-hint">Click to expand ▾</span>
          </div>
          ${c.heading ? `<p class="result-heading">${escapeHtml(c.heading)}</p>` : ''}
          <p class="result-text">${snippet}&hellip;</p>
        </div>
      `;
    }).join('') || '<p class="patch-hint">No direct matches found in the chunked text.</p>';

    resultsEl.querySelectorAll('.result-item').forEach(item => {
      item.addEventListener('click', () => toggleResultExpand(item, highlightRe));
      item.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleResultExpand(item, highlightRe); } });
    });
  }

  // ---------- Binder ----------
  function binderButtonHtml(doc, chunkId){
    return `<button type="button" class="btn-add-binder" data-doc="${doc}" data-cid="${escapeHtml(chunkId)}">＋ Add to Binder</button>`;
  }

  function wireBinderButtons(container){
    container.querySelectorAll('.btn-add-binder').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addToBinder(btn.dataset.doc, btn.dataset.cid);
        btn.textContent = 'Added ✓';
        btn.classList.add('added');
        btn.disabled = true;
        setTimeout(() => { btn.textContent = '＋ Add to Binder'; btn.classList.remove('added'); btn.disabled = false; }, 1200);
      });
    });
  }

  function addToBinder(doc, chunkId){
    if(!doc || !chunkId) return;
    if(state.binder.find(b => b.doc === doc && b.id === chunkId)) return;
    state.binder.push({ doc, id: chunkId });
    saveBinder();
    renderBinderTable();
    updateBinderBadge();
  }

  function removeFromBinder(doc, chunkId){
    state.binder = state.binder.filter(b => !(b.doc === doc && b.id === chunkId));
    saveBinder();
    renderBinderTable();
    updateBinderBadge();
  }

  function moveBinderItem(idx, dir){
    const newIdx = idx + dir;
    if(newIdx < 0 || newIdx >= state.binder.length) return;
    const tmp = state.binder[idx];
    state.binder[idx] = state.binder[newIdx];
    state.binder[newIdx] = tmp;
    saveBinder();
    renderBinderTable();
  }

  function saveBinder(){
    try{ localStorage.setItem('docs-binder', JSON.stringify(state.binder)); } catch(e){}
  }

  function loadBinder(){
    try{
      const raw = localStorage.getItem('docs-binder');
      state.binder = raw ? JSON.parse(raw) : [];
    } catch(e){ state.binder = []; }
  }

  function updateBinderBadge(){
    const badge = document.getElementById('binder-count');
    badge.textContent = state.binder.length;
    badge.hidden = state.binder.length === 0;
  }

  function renderBinderTable(){
    const table = document.getElementById('binder-table');
    const tbody = document.getElementById('binder-tbody');
    const empty = document.getElementById('binder-empty');
    if(state.binder.length === 0){
      table.hidden = true; empty.hidden = false;
      return;
    }
    table.hidden = false; empty.hidden = true;
    tbody.innerHTML = state.binder.map((b, i) => {
      const chunk = state.docs[b.doc] && state.docs[b.doc].chunks.find(c => c.id === b.id);
      if(!chunk) return '';
      const pages = chunk.pages[1] !== chunk.pages[0] ? `${chunk.pages[0]}–${chunk.pages[1]}` : `${chunk.pages[0]}`;
      const preview = escapeHtml(chunk.text.slice(0,140)) + (chunk.text.length>140?'…':'');
      return `
        <tr data-idx="${i}">
          <td class="binder-reorder">
            <button type="button" class="binder-move" data-dir="-1" ${i===0?'disabled':''} title="Move up">↑</button>
            <button type="button" class="binder-move" data-dir="1" ${i===state.binder.length-1?'disabled':''} title="Move down">↓</button>
          </td>
          <td>${escapeHtml(DOC_META[b.doc].title)}</td>
          <td>p. ${pages}</td>
          <td class="binder-preview">${preview}</td>
          <td><button type="button" class="binder-remove" title="Remove">✕</button></td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      const idx = parseInt(row.dataset.idx, 10);
      row.querySelectorAll('.binder-move').forEach(btn => {
        btn.addEventListener('click', () => moveBinderItem(idx, parseInt(btn.dataset.dir, 10)));
      });
      row.querySelector('.binder-remove').addEventListener('click', () => {
        removeFromBinder(state.binder[idx].doc, state.binder[idx].id);
      });
    });
  }

  function exportBinderPdf(){
    if(state.binder.length === 0){ alert('Binder is empty — add some excerpts first.'); return; }
    if(!window.jspdf){ alert('PDF library failed to load — check your connection and try again.'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const title = (document.getElementById('binder-title').value || 'Excerpt Bundle').trim();

    function addFooter(){
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(`Generated by Docs · ${new Date().toLocaleDateString()} · Drafting aid, not legal advice — verify against source documents.`, margin, pageHeight - 24);
      doc.text(String(doc.internal.getNumberOfPages()), pageWidth - margin, pageHeight - 24, { align: 'right' });
    }

    function ensureSpace(needed){
      if(y + needed > pageHeight - 50){
        addFooter();
        doc.addPage();
        y = margin;
      }
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(20);
    const titleLines = doc.splitTextToSize(title, maxWidth);
    doc.text(titleLines, margin, y + 10);
    y += titleLines.length * 26 + 10;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(110);
    doc.text(`Generated ${new Date().toLocaleString()} · ${state.binder.length} excerpt${state.binder.length===1?'':'s'} from ${Object.keys(state.docs).length} document${Object.keys(state.docs).length===1?'':'s'}`, margin, y);
    y += 28;

    doc.setDrawColor(210);
    doc.line(margin, y, pageWidth - margin, y);
    y += 24;

    state.binder.forEach((b, i) => {
      const chunk = state.docs[b.doc] && state.docs[b.doc].chunks.find(c => c.id === b.id);
      if(!chunk) return;
      const label = DOC_META[b.doc].title;
      const pages = chunk.pages[1] !== chunk.pages[0] ? `${chunk.pages[0]}–${chunk.pages[1]}` : `${chunk.pages[0]}`;

      const headTitle = `${i+1}. ${chunk.heading || 'Excerpt'}`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      const headLines = doc.splitTextToSize(headTitle, maxWidth);
      ensureSpace(headLines.length * 16 + 34);
      doc.setTextColor(20);
      doc.text(headLines, margin, y);
      y += headLines.length * 16 + 4;

      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(`${label} · p. ${pages} · chunk ${chunk.id}`, margin, y);
      y += 16;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(30);
      const bodyLines = doc.splitTextToSize(chunk.text, maxWidth);
      bodyLines.forEach(line => {
        ensureSpace(15);
        doc.text(line, margin, y);
        y += 14;
      });
      y += 20;
    });

    addFooter();
    const filename = title.replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf';
    doc.save(filename);
  }

  // ---------- Upload (Tier 2 — real PDF ingestion) ----------
  let pdfjsReady = false;
  function ensurePdfJs(){
    if(pdfjsReady) return;
    if(window.pdfjsLib){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      pdfjsReady = true;
    }
  }

  function initUpload(){
    const fileInput = document.getElementById('upload-file');
    const dropLabel = document.getElementById('upload-drop');
    const dropText = document.getElementById('upload-drop-label');
    const fields = document.getElementById('upload-fields');
    const titleInput = document.getElementById('upload-title');
    const subtitleInput = document.getElementById('upload-subtitle');
    const runBtn = document.getElementById('upload-run');
    const progress = document.getElementById('upload-progress');
    const progressFill = document.getElementById('upload-progress-fill');
    const progressLabel = document.getElementById('upload-progress-label');
    const resultEl = document.getElementById('upload-result');

    let selectedFile = null;

    function handleFile(file){
      if(!file || file.type !== 'application/pdf'){
        resultEl.innerHTML = '<p class="patch-hint">Please choose a PDF file.</p>';
        return;
      }
      selectedFile = file;
      dropText.textContent = `Selected: ${file.name}`;
      titleInput.value = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
      fields.hidden = false;
      resultEl.innerHTML = '';
    }

    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    dropLabel.addEventListener('dragover', e => { e.preventDefault(); dropLabel.classList.add('dragover'); });
    dropLabel.addEventListener('dragleave', () => dropLabel.classList.remove('dragover'));
    dropLabel.addEventListener('drop', e => {
      e.preventDefault();
      dropLabel.classList.remove('dragover');
      if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    runBtn.addEventListener('click', async () => {
      if(!selectedFile) return;
      const title = titleInput.value.trim();
      if(!title){ resultEl.innerHTML = '<p class="patch-hint">Give it a title first.</p>'; return; }

      ensurePdfJs();
      if(!window.pdfjsLib){
        resultEl.innerHTML = '<p class="patch-hint">PDF library failed to load — check your connection and try again.</p>';
        return;
      }

      runBtn.disabled = true;
      progress.hidden = false;
      resultEl.innerHTML = '';

      try{
        const arrayBuffer = await selectedFile.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages = [];
        for(let i = 1; i <= pdf.numPages; i++){
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const text = content.items.map(it => it.str).join(' ');
          pages.push(text);
          const pct = Math.round((i / pdf.numPages) * 100);
          progressFill.style.width = pct + '%';
          progressLabel.textContent = `Extracting page ${i} of ${pdf.numPages}…`;
        }

        progressLabel.textContent = 'Uploading and chunking…';
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ title, subtitle: subtitleInput.value.trim(), pages })
        });
        const data = await res.json();
        if(!res.ok || data.error){
          resultEl.innerHTML = `<p class="patch-hint">Error: ${escapeHtml(data.error || 'Upload failed.')}</p>`;
        } else {
          resultEl.innerHTML = `<p class="upload-success">✓ "${escapeHtml(data.title)}" uploaded — ${data.pages} pages, ${data.chunks} chunks, by ${escapeHtml(data.uploaded_by)}.</p>`;
          fields.hidden = true;
          dropText.textContent = 'Choose a PDF, or drag one here';
          fileInput.value = '';
          selectedFile = null;
          loadUploadedDocs();
        }
      } catch(e){
        resultEl.innerHTML = `<p class="patch-hint">Error extracting or uploading: ${escapeHtml(String(e.message || e))}</p>`;
      } finally {
        runBtn.disabled = false;
        progress.hidden = true;
        progressFill.style.width = '0%';
      }
    });

    loadUploadedDocs();
  }

  async function loadUploadedDocs(){
    const el = document.getElementById('upload-doc-list');
    if(!el) return;
    el.innerHTML = '<p class="patch-hint">Loading…</p>';
    try{
      const res = await fetch('/api/documents');
      const data = await res.json();
      if(!res.ok || data.error){
        el.innerHTML = `<p class="patch-hint">Error loading documents: ${escapeHtml(data.error || 'unknown')}</p>`;
        return;
      }
      if(!data.documents || data.documents.length === 0){
        el.innerHTML = '<p class="patch-hint">Nothing uploaded yet.</p>';
        return;
      }
      el.innerHTML = `
        <table class="binder-table">
          <thead><tr><th>Title</th><th>Pages</th><th>Chunks</th><th>Uploaded by</th><th>Date</th><th></th></tr></thead>
          <tbody>
            ${data.documents.map(d => `
              <tr data-id="${escapeHtml(d.id)}">
                <td>${escapeHtml(d.title)}${d.subtitle ? `<br><span class="ch-pages">${escapeHtml(d.subtitle)}</span>` : ''}</td>
                <td>${d.pages}</td>
                <td>${d.chunk_count}</td>
                <td>${escapeHtml(d.uploaded_by || '—')}</td>
                <td>${escapeHtml((d.created_at || '').slice(0,10))}</td>
                <td><button type="button" class="binder-remove doc-delete" title="Delete">✕</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      el.querySelectorAll('.doc-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('tr');
          const id = row.dataset.id;
          if(!confirm(`Delete "${id}" and all its chunks? This can't be undone.`)) return;
          btn.disabled = true;
          try{
            const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const data = await res.json();
            if(!res.ok || data.error){ alert('Delete failed: ' + (data.error || 'unknown')); btn.disabled = false; return; }
            loadUploadedDocs();
          } catch(e){
            alert('Delete failed: ' + e.message);
            btn.disabled = false;
          }
        });
      });
    } catch(e){
      el.innerHTML = `<p class="patch-hint">Network error loading documents.</p>`;
    }
  }

  function initBinder(){
    loadBinder();
    updateBinderBadge();
    renderBinderTable();
    document.getElementById('binder-clear').addEventListener('click', () => {
      if(state.binder.length && !confirm('Clear all excerpts from the binder?')) return;
      state.binder = [];
      saveBinder();
      renderBinderTable();
      updateBinderBadge();
    });
    document.getElementById('binder-export').addEventListener('click', exportBinderPdf);
  }

  // ---------- Citation parsing (shared by Flow / Brief / Devil's Advocate) ----------
  function parseCitation(str){
    // Generic — matches "<Document Title>, p.34" for whatever documents are
    // actually loaded, rather than any hardcoded document name.
    const m = str.match(/^(.+?),\s*p\.?\s*(\d+)/i);
    if(!m) return null;
    const titleGuess = m[1].trim().toLowerCase();
    const page = parseInt(m[2], 10);
    const docId = Object.keys(DOC_META).find(id => (DOC_META[id].title || '').toLowerCase() === titleGuess)
      || Object.keys(DOC_META).find(id => (DOC_META[id].title || '').toLowerCase().includes(titleGuess) || titleGuess.includes((DOC_META[id].title || '').toLowerCase()));
    if(!docId) return null;
    return { doc: docId, page };
  }

  function findChunkForCitation(citationStr){
    const parsed = parseCitation(citationStr);
    if(!parsed) return null;
    const chunks = (state.docs[parsed.doc] && state.docs[parsed.doc].chunks) || [];
    return { chunk: chunks.find(c => parsed.page >= c.pages[0] && parsed.page <= c.pages[1]), doc: parsed.doc };
  }

  function citationChipHtml(citationStr){
    return `<span class="citation-chip" data-citation="${escapeHtml(citationStr)}">${escapeHtml(citationStr)}</span>`;
  }

  function attachCitationHandlers(container){
    container.querySelectorAll('.citation-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const citation = chip.dataset.citation;
        const existing = chip.nextElementSibling;
        if(existing && existing.classList.contains('citation-detail')){
          existing.remove();
          return;
        }
        container.querySelectorAll('.citation-detail').forEach(d => d.remove());
        const found = findChunkForCitation(citation);
        const detail = document.createElement('div');
        detail.className = 'citation-detail';
        if(!found || !found.chunk){
          detail.innerHTML = `<p class="patch-hint">Could not locate this passage locally.</p>`;
        } else {
          detail.innerHTML = `${imageBlockHtml(found.doc, found.chunk, DOC_META[found.doc].title)}<p class="source-detail-text">${escapeHtml(found.chunk.text)}</p>${binderButtonHtml(found.doc, found.chunk.id)}`;
          wireBinderButtons(detail);
        }
        chip.insertAdjacentElement('afterend', detail);
      });
    });
  }

  // ---------- Structured generation (Flow / Brief / Devil's Advocate) ----------
  async function runStructuredGenerate(question, mode, outputEl, button, renderFn, sourcesEl){
    if(!question || !question.trim()){
      outputEl.innerHTML = '<p class="patch-hint">Type a topic or choose a sample first.</p>';
      return;
    }
    button.disabled = true;
    outputEl.innerHTML = '<p class="patch-hint">Retrieving passages and generating…</p>';
    if(sourcesEl) sourcesEl.innerHTML = '';
    try{
      const res = await fetch('/api/generate', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ question: question.trim(), mode })
      });
      const data = await res.json();
      if(!res.ok || data.error){
        outputEl.innerHTML = `<p class="patch-hint">Error: ${escapeHtml(data.error || 'Something went wrong.')}</p>`;
        return;
      }
      if(data.structured) renderFn(data.structured);
      else if(data.answer) outputEl.innerHTML = `<p class="patch-hint">${escapeHtml(data.answer)}</p>`;
      if(sourcesEl && data.sources) renderSources(sourcesEl, data.sources);
    } catch(e){
      outputEl.innerHTML = '<p class="patch-hint">Network error reaching /api/generate.</p>';
    } finally {
      button.disabled = false;
    }
  }

  function renderFlow(data){
    const el = document.getElementById('flow-output');
    if(!data.steps || data.steps.length === 0){
      el.innerHTML = `<p class="patch-hint">${escapeHtml(data.title || 'Not enough information in both manuals to reconstruct this flow.')}</p>`;
      return;
    }
    el.innerHTML = `
      <p class="flow-title">${escapeHtml(data.title)}</p>
      <div class="flow-steps">
        ${data.steps.map((s, i) => `
          <div class="flow-step">
            <div class="flow-step-num">${i+1}</div>
            <div class="flow-step-body">
              <p class="flow-step-title">${escapeHtml(s.title)}</p>
              <p class="flow-step-detail">${escapeHtml(s.detail)}</p>
              ${s.citation ? citationChipHtml(s.citation) : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    attachCitationHandlers(el);
  }

  function briefToText(data){
    const title = data.title || 'Briefing Memo';
    let out = `${title}\n${'='.repeat(title.length)}\n\nOVERVIEW\n${data.overview || ''}\n\nKEY DEFINITIONS\n`;
    (data.definitions||[]).forEach(d => { out += `- ${d.term}: ${d.definition} [${d.citation||''}]\n`; });
    out += `\nCROSS-REFERENCES\n`;
    (data.crossRefs||[]).forEach(r => { out += `- ${r.point} [${r.citation||''}]\n`; });
    out += `\nOPEN QUESTIONS\n`;
    (data.openQuestions||[]).forEach(q => { out += `- ${q}\n`; });
    out += `\n---\nGenerated by Docs AI Insights. Drafting aid only — not legal advice. Verify all citations against source documents.\n`;
    return out;
  }

  function renderBrief(data){
    const el = document.getElementById('brief-output');
    const defs = (data.definitions||[]).map(d => `
      <div class="brief-item"><span class="term">${escapeHtml(d.term)}:</span><p>${escapeHtml(d.definition)}</p>${d.citation?citationChipHtml(d.citation):''}</div>
    `).join('') || '<p class="patch-hint">None identified.</p>';
    const refs = (data.crossRefs||[]).map(r => `
      <div class="brief-item"><p>${escapeHtml(r.point)}</p>${r.citation?citationChipHtml(r.citation):''}</div>
    `).join('') || '<p class="patch-hint">None identified.</p>';
    const qs = (data.openQuestions||[]).map(q => `<p class="brief-question-item">${escapeHtml(q)}</p>`).join('') || '<p class="patch-hint">None identified.</p>';

    el.innerHTML = `
      <div class="brief-doc">
        <p class="brief-title">${escapeHtml(data.title || 'Briefing Memo')}</p>
        <div class="brief-section"><h4>Overview</h4><p class="brief-overview">${escapeHtml(data.overview || '')}</p></div>
        <div class="brief-section"><h4>Key Definitions</h4>${defs}</div>
        <div class="brief-section"><h4>Cross-References</h4>${refs}</div>
        <div class="brief-section"><h4>Open Questions</h4>${qs}</div>
        <div class="brief-actions">
          <button class="btn-secondary" id="brief-copy" type="button">Copy as text</button>
          <button class="btn-secondary" id="brief-download" type="button">Download .txt</button>
        </div>
      </div>
    `;
    attachCitationHandlers(el);

    const plainText = briefToText(data);
    document.getElementById('brief-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(plainText).then(() => {
        const btn = document.getElementById('brief-copy');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy as text'; }, 1500);
      });
    });
    document.getElementById('brief-download').addEventListener('click', () => {
      const blob = new Blob([plainText], {type:'text/plain'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (data.title || 'brief').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.txt';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function renderDevil(data){
    const el = document.getElementById('devil-output');
    const cps = (data.counterpoints||[]).map((c,i) => `
      <div class="devil-counterpoint">
        <span class="cp-num">${i+1}</span>
        <div><p>${escapeHtml(c.point)}</p>${c.citation?citationChipHtml(c.citation):''}</div>
      </div>
    `).join('') || '<p class="patch-hint">No significant counterpoints found — the claim holds up against what\'s in the documents.</p>';
    el.innerHTML = `
      <p class="devil-claim">"${escapeHtml(data.claim || '')}"</p>
      ${cps}
      ${data.assessment ? `<div class="devil-assessment">${escapeHtml(data.assessment)}</div>` : ''}
    `;
    attachCitationHandlers(el);
  }

  function initFlow(){
    const q = document.getElementById('flow-question');
    const out = document.getElementById('flow-output');
    document.getElementById('flow-run').addEventListener('click', (e) => {
      runStructuredGenerate(q.value, 'flow', out, e.currentTarget, renderFlow);
    });
  }

  function initBrief(){
    const q = document.getElementById('brief-question');
    const out = document.getElementById('brief-output');
    document.getElementById('brief-run').addEventListener('click', (e) => {
      runStructuredGenerate(q.value, 'brief', out, e.currentTarget, renderBrief);
    });
  }

  function renderSources(el, sources){
    if(!sources || !sources.length){ el.innerHTML = ''; return; }
    el.innerHTML = '<p class="sources-label">Sources used — click to view the passage:</p>'
      + '<div class="source-chip-row">' + sources.map((s, i) => {
          const pages = s.pages[1] !== s.pages[0] ? `${s.pages[0]}–${s.pages[1]}` : `${s.pages[0]}`;
          return `<button type="button" class="source-chip" data-doc="${s.doc}" data-cid="${escapeHtml(s.id)}">${escapeHtml(s.label)} p.${pages}${s.heading ? ' · ' + escapeHtml(s.heading) : ''}</button>`;
        }).join('') + '</div>'
      + '<div class="source-detail"></div>';

    el.querySelectorAll('.source-chip').forEach(chip => {
      chip.addEventListener('click', () => toggleSourceDetail(el, chip));
    });
  }

  function toggleSourceDetail(container, chip){
    const detail = container.querySelector('.source-detail');
    const wasActive = chip.classList.contains('active');
    container.querySelectorAll('.source-chip').forEach(c => c.classList.remove('active'));
    if(wasActive){
      detail.innerHTML = '';
      return;
    }
    chip.classList.add('active');
    const doc = chip.dataset.doc, cid = chip.dataset.cid;
    const chunk = state.docs[doc] && state.docs[doc].chunks.find(c => c.id === cid);
    if(!chunk){
      detail.innerHTML = '<p class="patch-hint">Could not find this passage in the loaded data.</p>';
      return;
    }
    detail.innerHTML = `${imageBlockHtml(doc, chunk, DOC_META[doc].title)}<p class="source-detail-text">${escapeHtml(chunk.text)}</p>${binderButtonHtml(doc, chunk.id)}`;
    wireBinderButtons(detail);
  }

  async function runGenerate(question, mode, outputEl, sourcesEl, button){
    if(!question || !question.trim()){
      outputEl.textContent = 'Type a question or choose a sample first.';
      sourcesEl.innerHTML = '';
      return;
    }
    button.disabled = true;
    outputEl.textContent = 'Retrieving relevant passages and asking Claude…';
    sourcesEl.innerHTML = '';
    try{
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ question: question.trim(), mode })
      });
      const data = await res.json();
      if(!res.ok || data.error){
        outputEl.textContent = 'Error: ' + (data.error || 'Something went wrong.');
        return;
      }
      outputEl.textContent = data.answer;
      renderSources(sourcesEl, data.sources);
    } catch(e){
      outputEl.textContent = 'Network error reaching /api/generate. If this site was deployed via Direct Upload rather than Git, functions/ may not have been included — check the deployment includes the functions folder.';
    } finally {
      button.disabled = false;
    }
  }

  function initInsights(){
    const askQuestion = document.getElementById('ask-question');
    const askOut = document.getElementById('ask-output');
    const askSources = document.getElementById('ask-sources');
    document.getElementById('ask-run').addEventListener('click', (e) => {
      runGenerate(askQuestion.value, 'answer', askOut, askSources, e.currentTarget);
    });

    const storyQuestion = document.getElementById('story-question');
    const storyOut = document.getElementById('story-output');
    const storySources = document.getElementById('story-sources');
    document.getElementById('story-run').addEventListener('click', (e) => {
      runGenerate(storyQuestion.value, 'story', storyOut, storySources, e.currentTarget);
    });

    const conflictQuestion = document.getElementById('conflict-question');
    const conflictOut = document.getElementById('conflict-output');
    const conflictSources = document.getElementById('conflict-sources');
    document.getElementById('conflict-run').addEventListener('click', (e) => {
      runGenerate(conflictQuestion.value, 'conflict', conflictOut, conflictSources, e.currentTarget);
    });

    const devilQuestion = document.getElementById('devil-question');
    const devilOut = document.getElementById('devil-output');
    const devilSources = document.getElementById('devil-sources');
    document.getElementById('devil-run').addEventListener('click', (e) => {
      runStructuredGenerate(devilQuestion.value, 'devil', devilOut, e.currentTarget, renderDevil, devilSources);
    });
  }

  // ---------- Init ----------
  async function init(){
    initTabs();
    try{
      await loadData();
    } catch(e){
      document.querySelector('main').innerHTML = `
        <div class="load-error">
          <h2>Something failed to load</h2>
          <p>Couldn't load the app. Open the browser console (F12) for the exact error.</p>
          <p class="load-error-detail">${escapeHtml(String(e && e.message || e))}</p>
        </div>`;
      console.error('Docs init failed:', e);
      return;
    }
    renderHeroStats();
    renderHeroPatchbay();
    renderLibrary();
    initSearch();
    initPatchbay();
    renderConceptGraph();
    initChunkExplorer();
    initFlow();
    initBrief();
    initInsights();
    initBinder();
    initUpload();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
