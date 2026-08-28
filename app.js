"use strict";

/* ============================================================
 * System Design Study Guide — composable viewer
 * Vanilla JS, no build step. Open a folder of *.json study guides.
 * ============================================================ */

/* ---------------- State ---------------- */
const state = {
  chapters: [],        // [{ id, series, number, title, source, data, filename }]
  activeChapterId: null,
  activeSeries: null,  // currently selected book
  mode: "all",         // all | study | reference
};

/* ---------------- Persistence (localStorage) ---------------- */
const PROGRESS_KEY = "sdsg_progress_v1";
const LOCATION_KEY = "sdsg_location_v1";
const UI_KEY = "sdsg_ui_v1";

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch (_) { return null; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* storage full or blocked */ }
}

let progress = readJSON(PROGRESS_KEY) || {};
function saveProgress() { writeJSON(PROGRESS_KEY, progress); }

function currentChapterKey() {
  const ch = state.chapters.find((c) => c.id === state.activeChapterId);
  return ch ? ch.filename : "";
}
function chapterProgress(chapterKey) {
  if (!progress[chapterKey]) progress[chapterKey] = { known: {}, quiz: {} };
  const p = progress[chapterKey];
  if (!p.known) p.known = {};
  if (!p.quiz) p.quiz = {};
  return p;
}
function itemKey(it, sectionKey, idx) {
  return (it && it.id) ? it.id : `${sectionKey}#${idx}`;
}
function saveLocation() {
  writeJSON(LOCATION_KEY, { book: state.activeSeries, chapter: currentChapterKey() });
}function resetProgress() {
  progress = {};
  saveProgress();
  try { localStorage.removeItem(LOCATION_KEY); } catch (_) { /* ignore */ }
  if (state.activeChapterId) renderChapter(state.activeChapterId);
}

/* Sections that get interactive study renderers. */
const STUDY_SECTIONS = new Set([
  "flashcards",
  "multiple_choice_questions",
  "true_false",
  "fill_in_the_blank",
  "ordering_exercises",
  "mix_and_match",
  "scenario_questions",
  "short_answer_questions",
  "active_recall_prompts",
  "interview_style_questions",
  "diagram_reconstruction_drills",
]);

/* Keys that identify a chapter's descriptive header, rendered specially. */
const HEADER_KEYS = new Set(["chapter"]);

/* ---------------- DOM helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function humanize(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bApis?\b/gi, "API")
    .replace(/\bCdn\b/gi, "CDN")
    .replace(/\bDns\b/gi, "DNS")
    .replace(/\bMcq\b/gi, "MCQ");
}

function normalizeAnswer(s) {
  return String(s).trim().toLowerCase().replace(/[.\s]+$/, "").replace(/\s+/g, " ");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- Folder / file loading ---------------- */

async function openFolderWithPicker() {
  clearError();
  try {
    const dirHandle = await window.showDirectoryPicker();
    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".json")) {
        const file = await entry.getFile();
        files.push(file);
      }
    }
    await loadFiles(files);
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled
    showError("Could not open folder: " + (err && err.message));
  }
}

async function loadFiles(fileList) {
  clearError();
  const files = Array.from(fileList).filter(
    (f) => f.name.toLowerCase().endsWith(".json") && f.name.toLowerCase() !== "manifest.json"
  );
  if (!files.length) {
    showError("No .json files were found in that selection.");
    return;
  }

  const chapters = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      chapters.push(buildChapter(file.name, data));
    } catch (err) {
      console.warn("Skipping unparseable file", file.name, err);
    }
  }

  if (!chapters.length) {
    showError("None of the selected files could be parsed as JSON.");
    return;
  }

  chapters.sort((a, b) => {
    if (a.series !== b.series) return a.series.localeCompare(b.series);
    if (a.number != null && b.number != null) return a.number - b.number;
    return a.filename.localeCompare(b.filename, undefined, { numeric: true });
  });

  state.chapters = chapters;
  const saved = readJSON(LOCATION_KEY);
  const startCh =
    (saved && chapters.find((c) => c.filename === saved.chapter)) || chapters[0];
  state.activeSeries = startCh.series;
  state.activeChapterId = startCh.id;
  showStudyUI();
  goToStudy();
  renderBookSelect();
  renderChapterList();
  renderChapter(startCh.id);
}

function deriveSeries(ch, data, filename) {
  const raw = ch.book || ch.source || data.book || data.source || "";
  if (raw) {
    return String(raw).split(/\s*[:\u2013\u2014]\s*| by /i)[0].trim();
  }
  const prefix = (filename.match(/^([a-z]+)_/i) || [])[1];
  return prefix ? prefix.toUpperCase() : "Study Guides";
}

function buildChapter(filename, data) {
  const ch = data && data.chapter ? data.chapter : {};
  const numberFromName = (filename.match(/chapter[_\-\s]*(\d+)/i) || [])[1];
  const number = ch.number != null ? ch.number : (numberFromName != null ? Number(numberFromName) : null);
  const title = ch.title || data.title || filename.replace(/\.json$/i, "");
  return {
    id: filename + ":" + Math.random().toString(36).slice(2, 7),
    series: deriveSeries(ch, data, filename),
    number,
    title,
    source: ch.source || data.source || "",
    data,
    filename,
  };
}

/* ---------------- Landing / error ---------------- */
function showError(msg) {
  const node = $("#landing-error");
  node.textContent = msg;
  node.hidden = false;
}
function clearError() {
  const node = $("#landing-error");
  if (node) { node.hidden = true; node.textContent = ""; }
}
/* ---------------- Routing (study is the main page; open is a separate page) ---------------- */
function hideBoot() { $("#boot").hidden = true; }
function showStudyUI() {
  hideBoot();
  $("#landing").hidden = true;
  $("#study").hidden = false;
}
function showOpenPage() {
  hideBoot();
  $("#study").hidden = true;
  $("#landing").hidden = false;
  $("#back-to-study-btn").hidden = state.chapters.length === 0;
}
function applyRoute() {
  const wantsOpen = location.hash === "#open";
  if (wantsOpen || state.chapters.length === 0) showOpenPage();
  else showStudyUI();
}
function goToOpenPage() { location.hash = "open"; }
function goToStudy() {
  if (location.hash === "#open") location.hash = "";
  else applyRoute();
}

function setSidebarCollapsed(collapsed) {
  $("#study").classList.toggle("sidebar-collapsed", collapsed);
  const btn = $("#sidebar-toggle");
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.title = collapsed ? "Show sidebar" : "Hide sidebar";
  const ui = readJSON(UI_KEY) || {};
  ui.sidebarCollapsed = collapsed;
  writeJSON(UI_KEY, ui);
}
function toggleSidebar() {
  setSidebarCollapsed(!$("#study").classList.contains("sidebar-collapsed"));
}

/* ---------------- Sidebar ---------------- */
function seriesList() {
  const seen = [];
  for (const ch of state.chapters) if (!seen.includes(ch.series)) seen.push(ch.series);
  return seen;
}

function renderBookSelect() {
  const select = $("#book-select");
  const books = seriesList();
  select.innerHTML = "";
  for (const s of books) {
    const count = state.chapters.filter((c) => c.series === s).length;
    select.append(el("option", { value: s, text: `${s}  (${count})` }));
  }
  select.value = state.activeSeries;
  select.style.display = books.length > 1 ? "" : "none";
}

function renderChapterList() {
  const list = $("#chapter-list");
  const filter = ($("#chapter-search").value || "").toLowerCase();
  list.innerHTML = "";
  for (const ch of state.chapters) {
    if (ch.series !== state.activeSeries) continue;
    const label = (ch.number != null ? `Chapter ${ch.number} — ` : "") + ch.title;
    if (filter && !label.toLowerCase().includes(filter)) continue;
    const btn = el("button", {
      class: "chapter-item" + (ch.id === state.activeChapterId ? " active" : ""),
      onClick: () => renderChapter(ch.id),
    }, [
      el("span", { class: "ch-num", text: ch.number != null ? `Chapter ${ch.number}` : ch.filename }),
      el("span", { text: ch.title }),
    ]);
    list.append(btn);
  }
  if (!list.children.length) {
    list.append(el("p", { class: "empty-note", style: "padding:8px 12px;", text: "No chapters match." }));
  }
}

function selectBook(series) {
  state.activeSeries = series;
  const first = state.chapters.find((c) => c.series === series);
  renderChapterList();
  if (first) renderChapter(first.id);
}

/* ---------------- Chapter rendering ---------------- */
function renderChapter(id) {
  const ch = state.chapters.find((c) => c.id === id);
  if (!ch) return;
  state.activeChapterId = id;
  if (ch.series !== state.activeSeries) {
    state.activeSeries = ch.series;
    $("#book-select").value = ch.series;
  }
  renderChapterList();

  $("#chapter-title").textContent =
    (ch.number != null ? `Chapter ${ch.number}: ` : "") + ch.title;
  const metaBits = [];
  if (ch.source) metaBits.push(ch.source);
  const cd = ch.data.chapter || {};
  if (cd.pdf_pages && cd.pdf_pages.start != null) {
    metaBits.push(`pp. ${cd.pdf_pages.start}–${cd.pdf_pages.end}`);
  }
  metaBits.push(ch.filename);
  $("#chapter-meta").textContent = metaBits.join("  ·  ");

  const container = $("#sections");
  const nav = $("#section-nav");
  container.innerHTML = "";
  nav.innerHTML = "";

  const entries = Object.entries(ch.data).filter(([k]) => !HEADER_KEYS.has(k));

  for (const [key, value] of entries) {
    const isStudy = STUDY_SECTIONS.has(key);
    const card = renderSection(key, value, isStudy);
    if (!card) continue;
    card.dataset.mode = isStudy ? "study" : "reference";
    card.id = "section-" + key;
    container.append(card);

    const chip = el("button", {
      class: "section-chip",
      "data-mode": isStudy ? "study" : "reference",
      onClick: () => card.scrollIntoView({ behavior: "smooth", block: "start" }),
    }, [
      humanize(key),
      el("span", { class: "chip-count", text: Array.isArray(value) ? `(${value.length})` : "" }),
    ]);
    nav.append(chip);
  }

  applyModeFilter();
  $(".content").scrollTop = 0;
  saveLocation();
}

/* Build one section card. Returns the card element. */
function renderSection(key, value, isStudy) {
  const count = Array.isArray(value) ? value.length : null;
  const header = el("div", { class: "section-header" }, [
    el("h2", { text: humanize(key) }),
    el("span", {
      class: "section-badge" + (isStudy ? " badge-study" : ""),
      text: isStudy ? "Study" : (count != null ? `${count} items` : "Reference"),
    }),
  ]);

  const body = el("div", { class: "section-body" });
  const renderer = STUDY_RENDERERS[key];
  if (renderer) {
    renderer(value, body, { chapterKey: currentChapterKey(), sectionKey: key });
  } else {
    body.append(renderGeneric(value));
  }

  return el("div", { class: "section-card" }, [header, body]);
}

/* ---------------- Mode filter (All / Study / Reference) ---------------- */
function applyModeFilter() {
  const mode = state.mode;
  for (const card of $$("#sections .section-card")) {
    card.style.display = mode === "all" || card.dataset.mode === mode ? "" : "none";
  }
  for (const chip of $$("#section-nav .section-chip")) {
    chip.style.display = mode === "all" || chip.dataset.mode === mode ? "" : "none";
  }
}

/* ============================================================
 * Generic recursive renderer (composable fallback)
 * ============================================================ */
function renderGeneric(value, keyHint) {
  if (value === null || value === undefined) {
    return el("span", { class: "empty-note", text: "—" });
  }
  if (keyHint === "source_pages" && Array.isArray(value)) {
    return renderPages(value);
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return el("span", { class: "g-str", text: String(value) });
  }
  if (Array.isArray(value)) return renderArray(value);
  if (t === "object") return renderObject(value);
  return el("span", { text: String(value) });
}

function renderPages(pages) {
  const wrap = el("span", { class: "pages" });
  for (const p of pages) wrap.append(el("span", { class: "page-badge", text: "p. " + p }));
  return wrap;
}

function isPrimitive(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function renderArray(arr) {
  if (!arr.length) return el("span", { class: "empty-note", text: "(empty)" });

  if (arr.every(isPrimitive)) {
    const ul = el("ul", { class: "g-list" });
    for (const item of arr) ul.append(el("li", { text: String(item) }));
    return ul;
  }

  const frag = document.createDocumentFragment();
  arr.forEach((item, i) => {
    if (isPrimitive(item)) {
      frag.append(el("div", { class: "g-obj-card" }, [String(item)]));
      return;
    }
    const titleText = pickTitle(item, i);
    const card = el("div", { class: "g-obj-card" });
    if (titleText) card.append(el("div", { class: "g-obj-title", text: titleText }));
    card.append(renderObject(item, titleText ? ["__title_used__"] : []));
    frag.append(card);
  });
  return frag;
}

/* Choose a human title for an object in an array. */
const TITLE_KEYS = ["title", "name", "term", "topic", "objective", "question",
  "prompt", "confusion", "statement", "scenario", "concept", "stage", "id"];
function pickTitle(obj, idx) {
  for (const k of TITLE_KEYS) {
    if (obj[k] != null && isPrimitive(obj[k])) {
      const prefix = obj.stage != null && k !== "stage" ? `Stage ${obj.stage}: ` : "";
      if (k === "id") continue; // id alone is a weak title
      return prefix + String(obj[k]);
    }
  }
  if (obj.stage != null) return `Stage ${obj.stage}`;
  return "";
}

function renderObject(obj, skipKeys = []) {
  const skip = new Set(skipKeys);
  // If a title key was used, avoid repeating it in the body.
  if (skip.has("__title_used__")) {
    for (const k of TITLE_KEYS) {
      if (obj[k] != null && isPrimitive(obj[k])) { skip.add(k); break; }
    }
  }
  const dl = el("div", { class: "kv" });
  const keys = Object.keys(obj).filter((k) => !skip.has(k));
  if (!keys.length) return el("span", { class: "empty-note", text: "—" });

  for (const k of keys) {
    const row = el("div", { class: "kv-row" }, [
      el("div", { class: "kv-key", text: humanize(k) }),
      el("div", { class: "kv-val" }, [renderGeneric(obj[k], k)]),
    ]);
    dl.append(row);
  }
  return dl;
}

/* ============================================================
 * Interactive study renderers
 * ============================================================ */
const STUDY_RENDERERS = {
  flashcards: renderFlashcards,
  multiple_choice_questions: renderMCQ,
  true_false: renderTrueFalse,
  fill_in_the_blank: renderFillBlank,
  ordering_exercises: renderOrdering,
  mix_and_match: renderMixMatch,
  scenario_questions: (v, root) => renderRevealList(v, root, {
    q: (it) => it.scenario ? `${it.scenario}\n\n${it.question || ""}` : it.question,
    a: (it) => it.expected_answer,
    extra: ["reasoning"],
  }),
  short_answer_questions: (v, root) => renderRevealList(v, root, {
    q: (it) => it.question,
    a: (it) => it.model_answer,
  }),
  active_recall_prompts: (v, root) => renderRevealList(v, root, {
    q: (it) => it.prompt,
    a: (it) => it.target_points,
    aLabel: "Target points",
  }),
  interview_style_questions: (v, root) => renderRevealList(v, root, {
    q: (it) => it.question,
    a: (it) => it.strong_answer_outline,
    aLabel: "Strong answer outline",
  }),
  diagram_reconstruction_drills: (v, root) => renderRevealList(v, root, {
    title: (it) => it.name,
    q: (it) => it.task,
    a: (it) => it.correct_flow || it.required_components || it.required_details,
    aLabel: "Solution",
    extra: ["required_components", "required_details", "examples"],
  }),
};

/* ----- Flashcards ----- */
function renderFlashcards(cards, root, ctx = {}) {
  if (!Array.isArray(cards) || !cards.length) {
    root.append(el("p", { class: "empty-note", text: "No flashcards." }));
    return;
  }
  const store = ctx.chapterKey ? chapterProgress(ctx.chapterKey) : null;
  const cardId = (i) => itemKey(cards[i], ctx.sectionKey || "flashcards", i);
  const savedKnown = new Set(
    store ? cards.map((_, i) => i).filter((i) => store.known[cardId(i)]) : []
  );
  const st = { order: cards.map((_, i) => i), pos: 0, flipped: false, known: savedKnown };

  const deck = el("div", { class: "deck" });
  const progress = el("span", { class: "deck-progress" });
  const cardEl = el("div", { class: "flashcard" });
  const inner = el("div", { class: "flashcard-inner" });
  const front = el("div", { class: "flashcard-face flashcard-front" });
  const back = el("div", { class: "flashcard-face flashcard-back" });
  inner.append(front, back);
  cardEl.append(inner);

  function current() { return cards[st.order[st.pos]]; }

  function paint() {
    const c = current();
    st.flipped = false;
    cardEl.classList.remove("flipped");
    front.innerHTML = "";
    back.innerHTML = "";
    front.append(
      el("div", { class: "flashcard-label", text: "Question" }),
      el("div", { class: "flashcard-text", text: c.front || "" }),
      el("div", { class: "flashcard-hint", text: "Click to reveal answer" }),
    );
    back.append(
      el("div", { class: "flashcard-label", text: "Answer" }),
      el("div", { class: "flashcard-text", text: c.back || "" }),
    );
    if (c.source_pages) back.append(el("div", { class: "flashcard-hint" }, [renderPages(c.source_pages)]));
    const known = st.known.has(st.order[st.pos]);
    progress.textContent = `Card ${st.pos + 1} / ${cards.length}  ·  Known: ${st.known.size}`;
    knownBtn.textContent = known ? "✓ Known" : "Mark known";
    knownBtn.classList.toggle("btn-primary", known);
    knownBtn.classList.toggle("btn-secondary", !known);
  }

  cardEl.addEventListener("click", () => {
    st.flipped = !st.flipped;
    cardEl.classList.toggle("flipped", st.flipped);
  });

  const prevBtn = el("button", { class: "btn btn-secondary btn-small", text: "← Prev",
    onClick: () => { st.pos = (st.pos - 1 + cards.length) % cards.length; paint(); } });
  const nextBtn = el("button", { class: "btn btn-secondary btn-small", text: "Next →",
    onClick: () => { st.pos = (st.pos + 1) % cards.length; paint(); } });
  const shuffleBtn = el("button", { class: "btn btn-ghost btn-small", text: "⤨ Shuffle",
    style: "color:var(--text-muted);border-color:var(--border);",
    onClick: () => { st.order = shuffle(st.order); st.pos = 0; paint(); } });
  const knownBtn = el("button", { class: "btn btn-secondary btn-small",
    onClick: () => {
      const idx = st.order[st.pos];
      if (st.known.has(idx)) st.known.delete(idx); else st.known.add(idx);
      if (store) {
        if (st.known.has(idx)) store.known[cardId(idx)] = 1;
        else delete store.known[cardId(idx)];
        saveProgress();
      }
      paint();
    } });

  const toolbar = el("div", { class: "deck-toolbar" }, [
    progress,
    el("div", { class: "deck-controls" }, [shuffleBtn]),
  ]);
  const navRow = el("div", { class: "deck-nav" }, [prevBtn, knownBtn, nextBtn]);

  deck.append(toolbar, cardEl, navRow);
  root.append(deck);
  paint();
}

/* ----- Multiple choice ----- */
function renderMCQ(items, root, ctx = {}) {
  const store = ctx.chapterKey ? chapterProgress(ctx.chapterKey) : null;
  const score = makeScore();
  root.append(score.pill);
  items.forEach((it, idx) => {
    const item = el("div", { class: "quiz-item" });
    item.append(quizHeader(it, it.question));
    const choices = el("div", { class: "choices" });
    let answered = false;
    const btns = {};
    const key = itemKey(it, ctx.sectionKey || "mcq", idx);

    const grade = (chosen, persist) => {
      if (answered) return;
      answered = true;
      const correct = chosen === it.answer;
      if (btns[chosen]) btns[chosen].classList.add(correct ? "correct" : "incorrect");
      if (btns[it.answer]) btns[it.answer].classList.add("correct");
      Object.values(btns).forEach((b) => (b.disabled = true));
      score.record(correct);
      exp.classList.remove("hidden-reveal");
      if (persist && store) { store.quiz[key] = { c: chosen, ok: correct }; saveProgress(); }
    };

    for (const [k, label] of Object.entries(it.choices || {})) {
      const btn = el("button", { class: "choice", "data-key": k }, [
        el("span", { class: "choice-key", text: k }),
        el("span", { text: label }),
      ]);
      btn.addEventListener("click", () => grade(k, true));
      btns[k] = btn;
      choices.append(btn);
    }
    item.append(choices);
    const exp = explanationBlock(it.explanation, it.source_pages);
    exp.classList.add("hidden-reveal");
    item.append(exp);
    root.append(item);

    const saved = store && store.quiz[key];
    if (saved) grade(saved.c, false);
  });
}

/* ----- True / false ----- */
function renderTrueFalse(items, root, ctx = {}) {
  const store = ctx.chapterKey ? chapterProgress(ctx.chapterKey) : null;
  const score = makeScore();
  root.append(score.pill);
  items.forEach((it, idx) => {
    const item = el("div", { class: "quiz-item" });
    item.append(el("div", { class: "quiz-q", text: it.statement }));
    let answered = false;
    const key = itemKey(it, ctx.sectionKey || "tf", idx);

    const grade = (val, persist) => {
      if (answered) return;
      answered = true;
      const correct = val === it.answer;
      const picked = val ? trueBtn : falseBtn;
      picked.classList.add(correct ? "correct" : "incorrect");
      if (!correct) (val ? falseBtn : trueBtn).classList.add("correct");
      trueBtn.disabled = falseBtn.disabled = true;
      score.record(correct);
      exp.classList.remove("hidden-reveal");
      if (persist && store) { store.quiz[key] = { c: val, ok: correct }; saveProgress(); }
    };

    const mk = (val, text) => {
      const b = el("button", { class: "tf-btn", text });
      b.addEventListener("click", () => grade(val, true));
      return b;
    };
    const trueBtn = mk(true, "True");
    const falseBtn = mk(false, "False");
    item.append(el("div", { class: "tf-buttons", style: "margin-top:10px;" }, [trueBtn, falseBtn]));
    const exp = explanationBlock(it.explanation || `Answer: ${it.answer ? "True" : "False"}.`, it.source_pages);
    exp.classList.add("hidden-reveal");
    item.append(exp);
    root.append(item);

    const saved = store && store.quiz[key];
    if (saved) grade(saved.c, false);
  });
}

/* ----- Fill in the blank ----- */
function renderFillBlank(items, root, ctx = {}) {
  const store = ctx.chapterKey ? chapterProgress(ctx.chapterKey) : null;
  const score = makeScore();
  root.append(score.pill);
  items.forEach((it, idx) => {
    const item = el("div", { class: "quiz-item" });
    item.append(el("div", { class: "quiz-q", text: it.prompt }));
    const input = el("input", { class: "fib-input", type: "text", placeholder: "Type your answer…" });
    let answered = false;
    const key = itemKey(it, ctx.sectionKey || "fib", idx);

    const grade = (persist) => {
      if (answered) return;
      const ok = normalizeAnswer(input.value) === normalizeAnswer(it.answer);
      input.classList.add(ok ? "correct" : "incorrect");
      input.disabled = true;
      answered = true;
      score.record(ok);
      exp.classList.remove("hidden-reveal");
      if (persist && store) { store.quiz[key] = { c: input.value, ok }; saveProgress(); }
    };
    const btn = el("button", { class: "reveal-btn", text: "Check", onClick: () => grade(true) });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") grade(true); });
    item.append(el("div", { class: "fib-row", style: "margin-top:10px;" }, [input, btn]));
    const exp = explanationBlock(`Answer: ${it.answer}`, it.source_pages);
    exp.classList.add("hidden-reveal");
    item.append(exp);
    root.append(item);

    const saved = store && store.quiz[key];
    if (saved) { input.value = saved.c; btn.disabled = true; grade(false); }
  });
}

/* ----- Ordering ----- */
function renderOrdering(items, root) {
  items.forEach((it) => {
    const item = el("div", { class: "quiz-item" });
    if (it.title) item.append(el("div", { class: "quiz-q", text: it.title }));
    let order = shuffle((it.items_scrambled || it.correct_order || []).map((_, i) => i));
    const source = it.items_scrambled || it.correct_order || [];
    const list = el("ul", { class: "order-list" });

    function paint(reveal) {
      list.innerHTML = "";
      order.forEach((srcIdx, pos) => {
        const text = source[srcIdx];
        const li = el("li", { class: "order-item" });
        if (reveal) {
          const correct = it.correct_order && it.correct_order[pos] === text;
          li.classList.add(correct ? "correct" : "incorrect");
        }
        const moves = el("div", { class: "order-move" }, [
          el("button", { text: "▲", disabled: pos === 0 || reveal,
            onClick: () => { [order[pos - 1], order[pos]] = [order[pos], order[pos - 1]]; paint(false); } }),
          el("button", { text: "▼", disabled: pos === order.length - 1 || reveal,
            onClick: () => { [order[pos + 1], order[pos]] = [order[pos], order[pos + 1]]; paint(false); } }),
        ]);
        li.append(el("span", { class: "order-index", text: pos + 1 }), el("span", { class: "order-text", text }), moves);
        list.append(li);
      });
    }
    paint(false);
    item.append(list);

    const checkBtn = el("button", { class: "reveal-btn", text: "Check order",
      onClick: () => paint(true) });
    const resetBtn = el("button", { class: "reveal-btn", text: "Reshuffle",
      onClick: () => { order = shuffle(source.map((_, i) => i)); paint(false); } });
    item.append(el("div", { class: "action-row" }, [checkBtn, resetBtn]));
    if (it.source_pages) item.append(el("div", { style: "margin-top:10px;" }, [renderPages(it.source_pages)]));
    root.append(item);
  });
}

/* ----- Mix & match ----- */
function renderMixMatch(items, root) {
  items.forEach((it) => {
    const item = el("div", { class: "quiz-item" });
    if (it.title) item.append(el("div", { class: "quiz-q", text: it.title }));
    if (it.instructions) item.append(el("div", { class: "mm-instructions", text: it.instructions }));

    const rightEntries = Object.entries(it.right || {});
    const selects = {};
    for (const [lk, lLabel] of Object.entries(it.left || {})) {
      const select = el("select", { class: "mm-select" });
      select.append(el("option", { value: "", text: "— choose —" }));
      for (const [rk, rLabel] of rightEntries) {
        select.append(el("option", { value: rk, text: `${rk}. ${rLabel}` }));
      }
      selects[lk] = select;
      item.append(el("div", { class: "mm-row" }, [
        el("div", { class: "mm-left" }, [el("strong", { text: lk + ". " }), lLabel]),
        el("span", { class: "mm-arrow", text: "→" }),
        select,
      ]));
    }

    const checkBtn = el("button", { class: "reveal-btn", text: "Check answers" });
    const resultPill = el("span", { class: "score-pill", style: "display:none;" });
    checkBtn.addEventListener("click", () => {
      let correct = 0;
      const total = Object.keys(selects).length;
      for (const [lk, select] of Object.entries(selects)) {
        const ok = select.value === String((it.answer_key || {})[lk]);
        select.classList.remove("correct", "incorrect");
        select.classList.add(ok ? "correct" : "incorrect");
        if (ok) correct++;
      }
      resultPill.textContent = `${correct} / ${total} correct`;
      resultPill.style.display = "";
    });
    const revealBtn = el("button", { class: "reveal-btn", text: "Show answers",
      onClick: () => {
        for (const [lk, select] of Object.entries(selects)) {
          select.value = String((it.answer_key || {})[lk]);
          select.classList.remove("incorrect");
          select.classList.add("correct");
        }
      } });
    item.append(el("div", { class: "action-row" }, [checkBtn, revealBtn, resultPill]));
    if (it.source_pages) item.append(el("div", { style: "margin-top:10px;" }, [renderPages(it.source_pages)]));
    root.append(item);
  });
}

/* ----- Generic reveal-answer list (scenarios, short answers, etc.) ----- */
function renderRevealList(items, root, cfg) {
  if (!Array.isArray(items) || !items.length) {
    root.append(el("p", { class: "empty-note", text: "No items." }));
    return;
  }
  items.forEach((it) => {
    const item = el("div", { class: "quiz-item" });
    if (cfg.title && cfg.title(it)) item.append(el("div", { class: "quiz-q", text: cfg.title(it) }));
    item.append(quizHeader(it, cfg.q(it)));

    const answer = cfg.a(it);
    const ansBody = el("div");
    if (Array.isArray(answer)) {
      ansBody.append(renderArray(answer));
    } else if (answer != null && typeof answer === "object") {
      ansBody.append(renderObject(answer));
    } else {
      ansBody.append(el("div", { class: "g-str", text: answer || "" }));
    }

    const exp = el("div", { class: "explanation hidden-reveal" }, [
      el("span", { class: "exp-label", text: cfg.aLabel || "Answer" }),
      ansBody,
    ]);
    if (it.source_pages) exp.append(el("div", { style: "margin-top:8px;" }, [renderPages(it.source_pages)]));

    const btn = el("button", { class: "reveal-btn", text: "Show answer",
      onClick: () => {
        const hidden = exp.classList.toggle("hidden-reveal");
        btn.textContent = hidden ? "Show answer" : "Hide answer";
      } });
    item.append(btn, exp);
    root.append(item);
  });
}

/* ----- Small shared builders ----- */
function quizHeader(it, questionText) {
  const frag = document.createDocumentFragment();
  if (it.difficulty) {
    frag.append(el("div", { class: "quiz-meta" }, [
      el("span", { class: "difficulty " + it.difficulty, text: it.difficulty }),
    ]));
  }
  frag.append(el("div", { class: "quiz-q", text: questionText || "" }));
  return frag;
}

function explanationBlock(text, pages) {
  const exp = el("div", { class: "explanation" }, [
    el("span", { class: "exp-label", text: "Explanation" }),
    el("div", { text: text || "" }),
  ]);
  if (pages) exp.append(el("div", { style: "margin-top:8px;" }, [renderPages(pages)]));
  return exp;
}

function makeScore() {
  const pill = el("span", { class: "score-pill", style: "margin-bottom:14px;display:inline-block;" });
  let right = 0, total = 0;
  const update = () => (pill.textContent = `Score: ${right} / ${total}`);
  update();
  return {
    pill,
    record(correct) { total++; if (correct) right++; update(); },
  };
}

/* ---------------- Auto-load bundled study guides ---------------- */
async function autoLoadBundled() {
  if (location.protocol === "file:") {
    const hint = $("#landing-hint");
    if (hint) {
      hint.innerHTML =
        "You opened this file directly, so the study guides can't load automatically. " +
        "Run <code>python3 -m http.server 8000</code> in this folder and open " +
        "<b>http://localhost:8000/</b> — or use a button above to pick the <code>json_docs</code> folder.";
    }
    return;
  }
  try {
    const names = await discoverBundledFiles();
    const files = [];
    for (const name of names) {
      try {
        const r = await fetch("json_docs/" + name, { cache: "no-store" });
        if (r.ok) files.push(new File([await r.text()], name, { type: "application/json" }));
      } catch (_) { /* skip missing file */ }
    }
    if (files.length) await loadFiles(files);
    else showOpenPage();
  } catch (_) {
    showOpenPage();
  }
}

/* Prefer the live directory listing (auto-picks up new files); fall back to manifest.json. */
async function discoverBundledFiles() {
  try {
    const res = await fetch("json_docs/", { cache: "no-store" });
    if (res.ok) {
      const html = await res.text();
      const names = new Set();
      for (const m of html.matchAll(/href="([^"]+\.json)"/gi)) {
        const name = decodeURIComponent(m[1].split("/").pop());
        if (name.toLowerCase() !== "manifest.json") names.add(name);
      }
      if (names.size) return [...names];
    }
  } catch (_) { /* listing unavailable on this host */ }

  const res = await fetch("json_docs/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error("no manifest");
  return res.json();
}

/* ---------------- Wire up UI ---------------- */
function init() {
  $("#open-folder-btn").addEventListener("click", () => {
    if (window.showDirectoryPicker) openFolderWithPicker();
    else $("#folder-input").click();
  });
  if (!window.showDirectoryPicker) {
    $("#open-folder-btn").textContent = "Choose folder…";
  }
  $("#folder-input").addEventListener("change", (e) => loadFiles(e.target.files));
  $("#files-input").addEventListener("change", (e) => loadFiles(e.target.files));
  $("#reopen-btn").addEventListener("click", goToOpenPage);
  $("#back-to-study-btn").addEventListener("click", goToStudy);
  $("#sidebar-toggle").addEventListener("click", toggleSidebar);
  window.addEventListener("hashchange", applyRoute);
  $("#reset-btn").addEventListener("click", () => {
    if (confirm("Clear all saved progress (known cards and quiz answers)?")) resetProgress();
  });
  $("#chapter-search").addEventListener("input", renderChapterList);
  $("#book-select").addEventListener("change", (e) => selectBook(e.target.value));

  $$("#mode-tabs .mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("#mode-tabs .mode-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.mode = tab.dataset.mode;
      applyModeFilter();
    });
  });

  // Decide the initial view without flashing the open page while auto-loading.
  if (location.hash === "#open" || location.protocol === "file:") {
    showOpenPage();
  }
  setSidebarCollapsed(!!(readJSON(UI_KEY) || {}).sidebarCollapsed);
  autoLoadBundled();
}

init();
