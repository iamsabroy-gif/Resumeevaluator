/**
 * Resume Evaluator SPA.
 *
 * No framework, no build step — Base44 hosting is SPA-only, and this mirrors
 * that constraint deliberately rather than reaching for a bundler. All state
 * lives in one object; every screen is a pure render(state) -> HTML function;
 * all mutation happens through the /api endpoints in src/server/routes.ts.
 */

const API = "/api";

const state = {
  screen: "upload",
  userId: "local-user",
  resume: null,
  bullets: [],
  extraction: null,
  jd: null,
  score: null,
  explanation: "",
  suggestions: [],
  draft: null,
  rescore: null, // { before, after, delta, comparability }
  evidenceGrades: {},
  error: null,
  busy: false,
  // per-card UI state, keyed by suggestion id: { responding: bool, draftText: string|null }
  cardUi: {},
};

const app = document.getElementById("app");

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: options.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error(data?.error || `Request failed: ${res.status}`);
  }
  return data;
}

function setState(patch) {
  Object.assign(state, patch);
  render();
}

async function guarded(fn) {
  setState({ busy: true, error: null });
  try {
    await fn();
  } catch (err) {
    setState({ error: err.message || String(err) });
  } finally {
    setState({ busy: false });
  }
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function evidenceBadge(grade) {
  if (!grade) return "";
  const labels = { a: "Strong evidence", b: "Vendor / industry study", c: "Advisory heuristic" };
  return `<span class="badge badge-${grade}" title="${esc(labels[grade] || "")}">${grade === "a" ? "Strong" : grade === "b" ? "Vendor study" : "Advisory"}</span>`;
}

// -------------------------------------------------------------- bootstrap

async function loadConfig() {
  try {
    const cfg = await api("/config");
    // Stored for later screens to read, not re-rendered here: forcing a
    // repaint on this async resolution would blow away in-progress form
    // input if the user starts typing before it lands. Nothing on the
    // upload screen depends on this data anyway.
    state.evidenceGrades = cfg.evidenceGrades || {};
  } catch {
    // Config is informational only; the app works without it.
  }
}

// ------------------------------------------------------------- rendering

function render() {
  app.innerHTML = "";
  app.appendChild(renderSteps());
  if (state.error) app.appendChild(renderError());

  switch (state.screen) {
    case "upload":
      app.appendChild(renderUploadScreen());
      break;
    case "score":
      app.appendChild(renderScoreScreen());
      break;
    case "suggestions":
      app.appendChild(renderSuggestionsScreen());
      break;
    case "draft":
      app.appendChild(renderDraftScreen());
      break;
  }
}

function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function renderSteps() {
  const steps = [
    ["upload", "1. Upload"],
    ["score", "2. Score"],
    ["suggestions", "3. Close gaps"],
    ["draft", "4. Review draft"],
  ];
  const order = steps.map((s) => s[0]);
  const currentIdx = order.indexOf(state.screen);
  return el(`
    <div class="steps">
      ${steps
        .map(([key, label], i) => {
          const cls = key === state.screen ? "active" : i < currentIdx ? "done" : "";
          return `<span class="${cls}">${esc(label)}</span>`;
        })
        .join("")}
    </div>
  `);
}

function renderError() {
  const node = el(`<div class="error-banner"></div>`);
  node.textContent = state.error;
  return node;
}

// -------------------------------------------------------- screen: upload

function renderUploadScreen() {
  const wrap = el(`
    <div>
      <h1>Resume Evaluator</h1>
      <p class="subtitle">Upload a resume and (optionally) paste a job description to get an ATS-style score with a full breakdown.</p>
      <div class="panel">
        <h2>Resume</h2>
        <div class="field">
          <label for="resume-file">Upload PDF or DOCX</label>
          <input type="file" id="resume-file" accept=".pdf,.docx,.txt" />
        </div>
        <div class="field">
          <label for="resume-text">...or paste resume text</label>
          <textarea id="resume-text" placeholder="Paste resume text here"></textarea>
        </div>
      </div>
      <div class="panel">
        <h2>Job description <span class="hint">(optional — scoring works without one)</span></h2>
        <div class="field">
          <textarea id="jd-text" placeholder="Paste the job description here"></textarea>
        </div>
      </div>
      <div class="row">
        <button id="submit-btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Scoring..." : "Score my resume"}</button>
      </div>
    </div>
  `);

  wrap.querySelector("#submit-btn").addEventListener("click", () => {
    // Read every form value before guarded() flips busy:true — that triggers
    // a re-render which rebuilds the DOM from state and would otherwise wipe
    // whatever the user typed out from under this same click handler.
    const file = document.getElementById("resume-file").files[0] || null;
    const pastedResume = document.getElementById("resume-text").value.trim();
    const jdText = document.getElementById("jd-text").value.trim();
    guarded(() => submitResume({ file, pastedResume, jdText }));
  });
  return wrap;
}

async function submitResume({ file, pastedResume, jdText }) {
  if (!file && !pastedResume) {
    throw new Error("Upload a resume file or paste resume text first.");
  }

  let uploadResult;
  if (file) {
    const form = new FormData();
    form.append("file", file);
    form.append("userId", state.userId);
    uploadResult = await api("/resumes", { method: "POST", body: form });
  } else {
    uploadResult = await api("/resumes", {
      method: "POST",
      body: JSON.stringify({ rawText: pastedResume, userId: state.userId, fileName: "pasted-resume.txt" }),
    });
  }

  let jd = null;
  if (jdText) {
    jd = await api("/job-descriptions", {
      method: "POST",
      body: JSON.stringify({ rawText: jdText, userId: state.userId }),
    });
  }

  const scoreResult = await api("/scores", {
    method: "POST",
    body: JSON.stringify({ resumeId: uploadResult.resume.id, jdId: jd?.id ?? null }),
  });

  setState({
    resume: uploadResult.resume,
    bullets: uploadResult.bullets,
    extraction: uploadResult.extraction,
    jd,
    score: scoreResult.score,
    explanation: scoreResult.explanation,
    screen: "score",
    suggestions: [],
    draft: null,
    rescore: null,
    cardUi: {},
  });
}

// --------------------------------------------------------- screen: score

const SIGNAL_LABELS = {
  keyword_match: "Keyword match",
  skills_alignment: "Skills alignment",
  format_quality: "Format quality",
  section_structure: "Section structure",
  content_density: "Content density",
};
const SIGNAL_WEIGHTS = {
  keyword_match: 0.35,
  skills_alignment: 0.25,
  format_quality: 0.2,
  section_structure: 0.12,
  content_density: 0.08,
};

function renderScoreScreen() {
  const score = state.score;
  if (!score) return el(`<div class="panel">No score yet.</div>`);

  const wrap = el(`<div></div>`);

  if (state.extraction && state.extraction.confidence !== "high") {
    const banner = el(`<div class="notice-banner"></div>`);
    banner.innerHTML =
      `<strong>Extraction confidence: ${esc(state.extraction.confidence)}.</strong> ` +
      esc(state.extraction.notes.join(" "));
    wrap.appendChild(banner);
  }

  const hero = el(`
    <div class="panel">
      <div class="score-hero">
        <div class="score-number">${score.final}<small>/100</small></div>
        <div class="score-meta">
          <div>Domain: <strong>${esc(score.domain)}</strong></div>
          <div>Mode: ${score.mode === "jd_targeted" ? "matched against your JD" : "generic (no JD supplied)"}</div>
          <div>Recency multiplier: x${score.recency_multiplier}</div>
          <div>Engine ${esc(score.engineVersion)}${score.semanticAvailable ? " · semantic layer on" : ""}</div>
        </div>
      </div>
      <div class="bars">
        ${Object.entries(SIGNAL_LABELS)
          .map(([key, label]) => {
            const value = score[key];
            const pct = Math.round(value * 100);
            return `
              <div class="bar-row">
                <div>${esc(label)} <span class="hint">(${Math.round(SIGNAL_WEIGHTS[key] * 100)}%)</span></div>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <div class="bar-value">${pct}%</div>
              </div>`;
          })
          .join("")}
      </div>
    </div>
  `);
  wrap.appendChild(hero);

  if (score.matched_skills.length || score.missing_skills.length) {
    const skillsPanel = el(`
      <div class="panel">
        <h2>Skills</h2>
        ${score.matched_skills.length ? `<h3>Matched (${score.matched_skills.length})</h3><div class="pill-list">${score.matched_skills.map((s) => `<span class="pill matched">${esc(s)}</span>`).join("")}</div>` : ""}
        ${score.missing_skills.length ? `<h3 style="margin-top:16px">Missing (${score.missing_skills.length})</h3><div class="pill-list">${score.missing_skills.map((s) => `<span class="pill missing">${esc(s)}</span>`).join("")}</div>` : ""}
      </div>
    `);
    wrap.appendChild(skillsPanel);
  }

  if (score.human_scan_flags_graded.length) {
    const flagsPanel = el(`
      <div class="panel">
        <h2>Human-screening flags</h2>
        <p class="hint" style="margin-top:-6px">Graded by evidence strength — solid badges are backed by peer-reviewed or large-sample research, dashed badges are advisory heuristics.</p>
        ${score.human_scan_flags_graded
          .map(
            (f) => `
          <div class="flag-row">
            ${evidenceBadge(f.evidence)}
            <div class="flag-text">${esc(f.message)}</div>
          </div>`
          )
          .join("")}
      </div>
    `);
    wrap.appendChild(flagsPanel);
  }

  if (score.knockouts.length) {
    const koPanel = el(`
      <div class="panel">
        <h2>Employment history flags</h2>
        ${score.knockouts.map((k) => `<div class="knockout">${esc(k)}</div>`).join("")}
      </div>
    `);
    wrap.appendChild(koPanel);
  }

  const actions = el(`
    <div class="row">
      <button id="find-gaps-btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Working..." : "Show me what to improve"}</button>
      <button class="secondary" id="start-over-btn">Start over</button>
    </div>
  `);
  actions.querySelector("#find-gaps-btn").addEventListener("click", () => guarded(loadSuggestions));
  actions.querySelector("#start-over-btn").addEventListener("click", () => setState({ screen: "upload" }));
  wrap.appendChild(actions);

  return wrap;
}

async function loadSuggestions() {
  const result = await api(`/scores/${state.score.id}/suggestions`, { method: "POST" });
  setState({ suggestions: result.suggestions, screen: "suggestions" });
}

// --------------------------------------------------- screen: suggestions

const GAP_TYPE_LABELS = { skill: "Missing skill", metric: "Needs a number", governance: "Formatting", phrasing: "Phrasing" };

function renderSuggestionsScreen() {
  const wrap = el(`<div></div>`);
  const intro = el(`
    <div class="panel">
      <h2>Close the gaps</h2>
      <p class="hint" style="margin-top:-4px">
        Answer honestly — a bullet is only ever drafted from what you write below.
        Saying "no" keeps the gap on record without asking again.
      </p>
    </div>
  `);
  wrap.appendChild(intro);

  if (!state.suggestions.length) {
    wrap.appendChild(el(`<div class="panel">No gaps found — this resume already covers everything the engine checks for.</div>`));
  }

  for (const s of state.suggestions) {
    wrap.appendChild(renderSuggestionCard(s));
  }

  const acceptedCount = state.suggestions.filter((s) => s.status === "accepted").length;
  const autoEditNote = el(`
    <div class="panel">
      <h3>Ready to build a draft?</h3>
      <p class="hint">This also runs a safe auto-edit pass over every bullet — rephrasing only, no new claims — then re-scores the result so you can see the difference.</p>
      <div class="row">
        <button id="build-draft-btn" ${state.busy ? "disabled" : ""}>${state.busy ? "Building..." : `Build draft${acceptedCount ? ` (${acceptedCount} accepted)` : ""}`}</button>
        <button class="secondary" id="back-to-score-btn">Back to score</button>
      </div>
    </div>
  `);
  autoEditNote.querySelector("#build-draft-btn").addEventListener("click", () => guarded(buildAndRescoreDraft));
  autoEditNote.querySelector("#back-to-score-btn").addEventListener("click", () => setState({ screen: "score" }));
  wrap.appendChild(autoEditNote);

  return wrap;
}

function renderSuggestionCard(s) {
  const ui = state.cardUi[s.id] || {};
  const card = el(`<div class="panel card" data-id="${s.id}"></div>`);

  const head = el(`
    <div class="card-head">
      <div>
        <div class="gap-type">${esc(GAP_TYPE_LABELS[s.gapType] || s.gapType)}</div>
        <div>${esc(s.jdEvidence)}${s.evidence ? " " + evidenceBadge(s.evidence) : ""}</div>
      </div>
      <div class="card-status ${s.status}">${esc(s.status.replace("_", " "))}</div>
    </div>
  `);
  card.appendChild(head);

  if (s.status === "suggested") {
    const responder = el(`
      <div>
        <div class="confidence-buttons">
          <button data-level="yes">Yes, I have this</button>
          <button data-level="partial">Partial / adjacent</button>
          <button data-level="no">No</button>
        </div>
        ${
          ui.responding
            ? `<div class="field"><label>Describe it in your own words</label><textarea id="input-${s.id}" placeholder="What did you actually do? Be specific — this is the only source of fact for the draft."></textarea></div>
               <button data-action="submit-response">Submit</button>`
            : ""
        }
      </div>
    `);
    responder.querySelectorAll("[data-level]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const level = btn.dataset.level;
        if (level === "no") {
          guarded(() => respondSuggestion(s.id, "no", ""));
        } else {
          state.cardUi[s.id] = { ...ui, responding: true, level };
          render();
        }
      });
    });
    const submitBtn = responder.querySelector('[data-action="submit-response"]');
    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        const text = document.getElementById(`input-${s.id}`).value.trim();
        if (!text) {
          setState({ error: "Describe the experience before submitting — the draft is built only from what you write here." });
          return;
        }
        guarded(() => respondSuggestion(s.id, ui.level, text));
      });
    }
    card.appendChild(responder);
  }

  if (s.status === "user_responded") {
    if (s.validationError) {
      const warn = el(`<div class="notice-banner"></div>`);
      warn.textContent = s.validationError;
      card.appendChild(warn);
      const retry = el(`
        <div>
          <div class="field"><label>Add more detail</label><textarea id="retry-${s.id}">${esc(s.userInput || "")}</textarea></div>
          <button data-action="retry">Try drafting again</button>
        </div>
      `);
      retry.querySelector("[data-action='retry']").addEventListener("click", () => {
        const text = document.getElementById(`retry-${s.id}`).value.trim();
        guarded(() => retryDraft(s.id, text));
      });
      card.appendChild(retry);
    } else {
      card.appendChild(el(`<div class="loading">Drafting...</div>`));
    }
  }

  if (s.status === "drafted" || s.status === "edited") {
    const draftBox = el(`
      <div>
        <div class="draft-box">
          <div class="draft-label">Draft bullet</div>
          <div id="draft-text-${s.id}">${esc(s.draftBullet || "")}</div>
        </div>
        ${s.unquantifiedGaps.length ? `<div class="gap-note">${esc(s.unquantifiedGaps.join(" "))}</div>` : ""}
        <div class="row" style="margin-top:10px">
          <button data-action="accept">Accept</button>
          <button class="secondary" data-action="edit">Edit</button>
          <button class="secondary" data-action="decline">Decline</button>
        </div>
      </div>
    `);
    draftBox.querySelector("[data-action='accept']").addEventListener("click", () =>
      guarded(() => acceptCard(s.id))
    );
    draftBox.querySelector("[data-action='decline']").addEventListener("click", () =>
      guarded(() => declineCard(s.id))
    );
    draftBox.querySelector("[data-action='edit']").addEventListener("click", () => {
      const target = draftBox.querySelector(`#draft-text-${s.id}`);
      target.outerHTML = `<textarea id="edit-${s.id}">${esc(s.draftBullet || "")}</textarea><button data-action="save-edit" style="margin-top:8px">Save edit</button>`;
      draftBox.querySelector("[data-action='save-edit']").addEventListener("click", () => {
        const text = document.getElementById(`edit-${s.id}`).value.trim();
        guarded(() => saveEdit(s.id, text));
      });
    });
    card.appendChild(draftBox);
  }

  if (s.status === "accepted") {
    const box = el(`<div class="draft-box"><div class="draft-label">Accepted</div>${esc(s.draftBullet || "")}</div>`);
    card.appendChild(box);
  }

  return card;
}

async function respondSuggestion(id, confidenceLevel, userInput) {
  const updated = await api(`/suggestions/${id}/respond`, {
    method: "POST",
    body: JSON.stringify({ confidenceLevel, userInput }),
  });
  replaceSuggestion(updated);
}

async function retryDraft(id, userInput) {
  const updated = await api(`/suggestions/${id}/retry-draft`, {
    method: "POST",
    body: JSON.stringify({ userInput }),
  });
  replaceSuggestion(updated);
}

async function acceptCard(id) {
  const updated = await api(`/suggestions/${id}/accept`, { method: "POST" });
  replaceSuggestion(updated);
}

async function declineCard(id) {
  const updated = await api(`/suggestions/${id}/decline`, { method: "POST" });
  replaceSuggestion(updated);
}

async function saveEdit(id, text) {
  const updated = await api(`/suggestions/${id}/edit`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  replaceSuggestion(updated);
}

function replaceSuggestion(updated) {
  const idx = state.suggestions.findIndex((s) => s.id === updated.id);
  if (idx >= 0) state.suggestions[idx] = updated;
  render();
}

async function buildAndRescoreDraft() {
  const built = await api("/drafts", {
    method: "POST",
    body: JSON.stringify({ resumeId: state.resume.id, scoreResultId: state.score.id }),
  });
  const rescored = await api(`/drafts/${built.draft.id}/rescore`, { method: "POST" });
  setState({ draft: rescored.draft, rescore: rescored, screen: "draft" });
}

// --------------------------------------------------------- screen: draft

function renderDraftScreen() {
  const wrap = el(`<div></div>`);
  const r = state.rescore;

  if (r) {
    const deltaClass = r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat";
    const sign = r.delta > 0 ? "+" : "";
    const summary = el(`
      <div class="panel">
        <h2>Re-scored draft</h2>
        <div class="row" style="align-items:baseline">
          <div>Before: <strong>${r.before.final}</strong></div>
          <div>After: <strong>${r.after.final}</strong></div>
          <div class="delta ${deltaClass}">${sign}${r.delta}</div>
        </div>
        ${
          r.comparability && r.comparability.length
            ? `<div class="notice-banner" style="margin-top:12px">Not directly comparable: ${esc(r.comparability.join("; "))}</div>`
            : ""
        }
      </div>
    `);
    wrap.appendChild(summary);
  }

  if (state.draft) {
    const bulletsPanel = el(`<div class="panel"><h2>Before / after</h2></div>`);
    for (const b of state.draft.bullets) {
      const row = el(`
        <div class="bullet-diff">
          <div class="origin-tag">${esc(b.origin.replace("_", " "))}</div>
          ${b.originalText && b.originalText !== b.finalText ? `<div class="before">${esc(b.originalText)}</div>` : ""}
          <div class="after">${esc(b.finalText)}</div>
          ${b.changesMade.length ? `<div class="hint">${esc(b.changesMade.join("; "))}</div>` : ""}
        </div>
      `);
      bulletsPanel.appendChild(row);
    }
    wrap.appendChild(bulletsPanel);
  }

  const actions = el(`
    <div class="row">
      <button class="secondary" id="back-to-suggestions-btn">Back to suggestions</button>
      <button class="secondary" id="start-over-btn">Start over with a new resume</button>
    </div>
  `);
  actions.querySelector("#back-to-suggestions-btn").addEventListener("click", () => setState({ screen: "suggestions" }));
  actions.querySelector("#start-over-btn").addEventListener("click", () =>
    setState({
      screen: "upload",
      resume: null,
      bullets: [],
      extraction: null,
      jd: null,
      score: null,
      suggestions: [],
      draft: null,
      rescore: null,
      cardUi: {},
    })
  );
  wrap.appendChild(actions);

  return wrap;
}

// ------------------------------------------------------------------ init

render();
loadConfig();
