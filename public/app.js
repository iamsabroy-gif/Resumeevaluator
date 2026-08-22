/**
 * Resume Evaluator SPA — Modern ATS Scoring & AI Gap Rewriter.
 *
 * All state lives in one object; every screen is a pure render(state) -> HTML function;
 * all mutation happens through the /api endpoints in src/server/routes.ts.
 */

const API = "/api";

// Realistic sample data for instant 1-click previewing and testing
const SAMPLE_DATA = {
  resumeText: `Alex Morgan
alex.morgan@example.com | (555) 234-5678 | San Francisco, CA | linkedin.com/in/alexmorgan

SUMMARY
Results-driven Payments Product Operations Specialist with 6+ years of experience in merchant acquiring, settlement reconciliation, and dispute management. Proven track record improving operational efficiency across card scheme processing and ACH workflows.

EXPERIENCE

Senior Payments Operations Analyst | FinPay Global | 2021 - Present
- Responsible for daily settlement across a book of 3,000+ merchants processing over $120M in monthly gross payment volume.
- Partnered with engineering on an ACH ingestion pipeline that cut manual reconciliation time and reduced intake exceptions.
- Reconciled daily settlement files against card scheme reports for Visa, Mastercard, and American Express.
- Investigated exceptions and resolved discrepancies with issuing banks to maintain 99.98% financial accuracy.
- Handling monthly regulatory reporting for the acquiring desk ensuring full PCI DSS compliance.

Payments Specialist | Horizon Commerce | 2018 - 2021
- Managed end-to-end chargeback and dispute lifecycles across multiple card schemes, recovering lost revenue.
- Collaborated with risk teams to identify anomalous transaction patterns and reduce fraud rates on e-commerce transactions.
- Executed SEPA and wire transfers for cross-border merchant payouts across European jurisdictions.

EDUCATION & CERTIFICATIONS
Bachelor of Science in Finance & Information Systems | UC Berkeley
Certifications: Certified Payments Professional (CPP), PCI DSS Compliance Specialist`,

  jdText: `Senior Payments Operations Lead — Stripe / Fintech

About the Role:
We are looking for an experienced Payments Operations Lead to scale our acquiring infrastructure and settlement operations. You will oversee daily reconciliation, chargebacks, and compliance across global card schemes and alternative payment methods.

Requirements & Responsibilities:
- 5+ years experience in payment operations, acquiring, merchant settlement, and dispute resolution.
- Deep hands-on knowledge of card schemes (Visa, Mastercard), ACH, SEPA, and wire networks.
- Experience with AML (Anti-Money Laundering) transaction monitoring and KYC verification workflows.
- Expertise in payment orchestration platforms, tokenization protocols, and gateway routing.
- Strong understanding of PCI DSS compliance and financial reconciliation standards.
- Strong analytical skills, ability to partner with engineering teams to automate manual operational workflows.`
};

const state = {
  screen: "upload",
  userId: "local-user",
  resume: null,
  resumeFileName: null,
  selectedFile: null,
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
  // per-card UI state, keyed by suggestion id: { responding: bool, level: string, draftText: string|null }
  cardUi: {},
  // JD input mode
  jdMode: "paste",      // "paste" | "url"
  jdUrl: "",            // preserved across re-renders
  jdText: "",           // preserved across re-renders
  jdFetching: false,
  jdFetchError: null,   // inline error string
  // Study links feature flag (populated from /api/config, defaults true so
  // the button appears even before config loads -- fallback URL always works)
  studyLinksEnabled: true,
};

const app = document.getElementById("app");
const toastContainer = document.getElementById("toast-container");

// ------------------------------------------------------------- Toast Utility

function showToast(message, type = "info") {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${type === "success" ? "✓" : type === "error" ? "⚠️" : "ℹ"}</span>
    <div>${esc(message)}</div>
  `;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ----------------------------------------------------------------- API Fetch

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
    showToast(err.message || String(err), "error");
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
  const labels = {
    a: "Strong evidence — peer-reviewed or large-sample study",
    b: "Vendor / industry study — vendor research or empirical telemetry",
    c: "Advisory heuristic — recruiter heuristic / advisory nudge"
  };
  const title = labels[grade] || "";
  const text = grade === "a" ? "Strong Evidence" : grade === "b" ? "Industry Study" : "Advisory";
  return `<span class="badge badge-${grade}" title="${esc(title)}">${text}</span>`;
}

// -------------------------------------------------------------- Bootstrap

async function loadConfig() {
  try {
    const cfg = await api("/config");
    state.evidenceGrades = cfg.evidenceGrades || {};
    // studyLinksEnabled: true when a YOUTUBE_API_KEY is set server-side;
    // false means we still show the button (fallback URL path is always safe).
    if (typeof cfg.studyLinksEnabled === "boolean") {
      state.studyLinksEnabled = cfg.studyLinksEnabled;
    }
  } catch {
    // Config is informational only; the app works without it.
  }
}

// ------------------------------------------------------------- Rendering

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
    ["upload", "1", "Upload Resume"],
    ["score", "2", "ATS Score"],
    ["suggestions", "3", "Close Gaps"],
    ["draft", "4", "Review Draft"],
  ];
  const order = steps.map((s) => s[0]);
  const currentIdx = order.indexOf(state.screen);
  return el(`
    <div class="steps-container">
      <div class="steps">
        ${steps
          .map(([key, num, label], i) => {
            const isActive = key === state.screen;
            const isDone = i < currentIdx;
            const cls = isActive ? "active" : isDone ? "done" : "";
            const icon = isDone ? "✓" : num;
            return `
              <div class="step-item ${cls}">
                <span class="step-num">${icon}</span>
                <span>${esc(label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `);
}

function renderError() {
  const node = el(`
    <div class="error-banner" role="alert">
      <span style="font-size:18px">⚠️</span>
      <div>${esc(state.error)}</div>
    </div>
  `);
  return node;
}

// -------------------------------------------------------- Screen: Upload

function renderUploadScreen() {
  const wrap = el(`
    <div>
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:8px">
        <div>
          <h1>Resume Evaluator</h1>
          <p class="subtitle">Evidence-backed ATS scoring and human-in-the-loop bullet rewriting.</p>
        </div>
      </div>

      <!-- Quick Sample Loader Pill -->
      <div class="sample-loader-box">
        <div class="sample-loader-text">
          <strong>Want a test run?</strong> Load a sample Payments Operations resume & job description with one click.
        </div>
        <button id="load-sample-btn" class="secondary" style="font-size:13px; padding:6px 14px;">
          ⚡ Load Sample Data
        </button>
      </div>

      <div class="panel">
        <div class="panel-header-row">
          <h2>1. Resume</h2>
          <span class="hint">Supported: PDF, DOCX, or plain text</span>
        </div>

        <div class="field">
          <label>File Upload</label>
          <div class="dropzone" id="resume-dropzone">
            <input type="file" id="resume-file" accept=".pdf,.docx,.txt" />
            <div class="dropzone-icon">📄</div>
            <div class="dropzone-title">Drop your resume here, or <span style="color:var(--accent-light); text-decoration:underline;">browse files</span></div>
            <div class="dropzone-hint">PDF or DOCX with text layer, max 10MB</div>
          </div>
          <div id="file-info-container"></div>
        </div>

        <div class="field" style="margin-top:20px;">
          <label for="resume-text">...or paste resume text directly</label>
          <textarea id="resume-text" placeholder="Paste full resume text here...">${esc(state.resumeText || "")}</textarea>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header-row">
          <h2>2. Job Description <span class="hint">(optional — enables keyword & skills matching)</span></h2>
        </div>

        <div class="tabs" role="tablist">
          <button class="tab-btn${state.jdMode === "paste" ? " active" : ""}" id="jd-tab-paste" data-jd-mode="paste" role="tab">Paste Text</button>
          <button class="tab-btn${state.jdMode === "url" ? " active" : ""}" id="jd-tab-url" data-jd-mode="url" role="tab">Import from URL</button>
        </div>

        ${state.jdMode === "paste" ? `
        <div class="field" id="jd-paste-panel">
          <textarea id="jd-text" placeholder="Paste the target job description here...">${esc(state.jdText)}</textarea>
        </div>
        ` : `
        <div id="jd-url-panel">
          <div class="field">
            <label for="jd-url">Public Job Posting URL</label>
            <div style="display:flex; gap:10px; align-items:center;">
              <input type="url" id="jd-url" placeholder="https://boards.greenhouse.io/..." value="${esc(state.jdUrl)}" />
              <button id="fetch-jd-btn" class="secondary" style="flex-shrink:0" ${state.jdFetching ? "disabled" : ""}>
                ${state.jdFetching ? `<span class="loading-spinner"></span> Fetching…` : "Fetch JD"}
              </button>
            </div>
          </div>
          <p class="hint jd-public-hint" style="margin-bottom:12px;">Works with publicly viewable job postings (Greenhouse, Lever, public job boards). Gated or login-walled pages must be pasted directly.</p>
          ${state.jdFetchError ? `
          <div class="jd-fetch-error" role="alert">
            ${esc(state.jdFetchError)}
            <br><a href="#" id="jd-paste-fallback-link" style="color:inherit;text-decoration:underline;margin-top:4px;display:inline-block;">Paste job description text instead →</a>
          </div>` : ""}
          ${state.jdText ? `
          <div class="field" style="margin-top:14px">
            <label for="jd-preview">Fetched Job Description <span class="hint">(review and edit before scoring)</span></label>
            <textarea id="jd-preview" rows="8">${esc(state.jdText)}</textarea>
          </div>` : ""}
        </div>
        `}
      </div>

      <div class="row" style="margin-top:24px;">
        <button id="submit-btn" style="padding:12px 28px; font-size:15px;" ${state.busy ? "disabled" : ""}>
          ${state.busy ? `<span class="loading-spinner"></span> Analyzing & Scoring...` : "✨ Score My Resume"}
        </button>
      </div>
    </div>
  `);

  // Render file selection state if any
  const fileContainer = wrap.querySelector("#file-info-container");
  if (state.selectedFile && fileContainer) {
    const fileBadge = el(`
      <div class="file-selected-badge">
        <div class="file-selected-name">
          <span>📎</span>
          <strong>${esc(state.selectedFile.name)}</strong>
          <span class="hint">(${(state.selectedFile.size / 1024).toFixed(1)} KB)</span>
        </div>
        <button class="ghost" id="remove-file-btn" style="color:var(--bad-light); padding:2px 8px; font-size:12px;">Remove</button>
      </div>
    `);
    fileBadge.querySelector("#remove-file-btn").addEventListener("click", () => {
      state.selectedFile = null;
      render();
    });
    fileContainer.appendChild(fileBadge);
  }

  // Load Sample Data Event
  wrap.querySelector("#load-sample-btn").addEventListener("click", () => {
    state.resumeText = SAMPLE_DATA.resumeText;
    state.jdText = SAMPLE_DATA.jdText;
    state.selectedFile = null;
    state.jdMode = "paste";
    showToast("Sample payments resume & job description loaded!", "success");
    render();
  });

  // Drag & Drop Handlers
  const dropzone = wrap.querySelector("#resume-dropzone");
  const fileInput = wrap.querySelector("#resume-file");

  if (dropzone && fileInput) {
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("is-dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      if (e.dataTransfer.files?.length) {
        state.selectedFile = e.dataTransfer.files[0];
        render();
      }
    });
    fileInput.addEventListener("change", (e) => {
      if (e.target.files?.length) {
        state.selectedFile = e.target.files[0];
        render();
      }
    });
  }

  // Tab switching
  wrap.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-jd-mode");
      if (mode === state.jdMode) return;
      if (state.jdMode === "paste") {
        state.jdText = document.getElementById("jd-text")?.value ?? state.jdText;
      } else {
        state.jdUrl = document.getElementById("jd-url")?.value ?? state.jdUrl;
        state.jdText = document.getElementById("jd-preview")?.value ?? state.jdText;
      }
      setState({ jdMode: mode, jdFetchError: null });
    });
  });

  // Fetch URL button
  const fetchBtn = wrap.querySelector("#fetch-jd-btn");
  if (fetchBtn) {
    fetchBtn.addEventListener("click", () => {
      const url = (document.getElementById("jd-url")?.value ?? "").trim();
      state.jdUrl = url;
      fetchJdFromUrl(url);
    });
  }

  // Inline fallback link
  const fallbackLink = wrap.querySelector("#jd-paste-fallback-link");
  if (fallbackLink) {
    fallbackLink.addEventListener("click", (e) => {
      e.preventDefault();
      state.jdText = document.getElementById("jd-preview")?.value ?? state.jdText;
      setState({ jdMode: "paste", jdFetchError: null });
    });
  }

  // Submit button
  wrap.querySelector("#submit-btn").addEventListener("click", () => {
    const pastedResume = (document.getElementById("resume-text")?.value ?? state.resumeText ?? "").trim();
    state.resumeText = pastedResume;
    if (state.jdMode === "paste") {
      state.jdText = document.getElementById("jd-text")?.value ?? state.jdText;
    } else {
      state.jdUrl = document.getElementById("jd-url")?.value ?? state.jdUrl;
      const preview = document.getElementById("jd-preview");
      if (preview) state.jdText = preview.value;
    }
    guarded(() => submitResume({ file: state.selectedFile, pastedResume }));
  });

  return wrap;
}

/** Fetch a JD from URL */
async function fetchJdFromUrl(url) {
  if (!url) {
    setState({ jdFetchError: "Please enter a job posting URL first." });
    return;
  }
  setState({ jdFetching: true, jdFetchError: null });
  try {
    const jd = await api("/job-descriptions", {
      method: "POST",
      body: JSON.stringify({ sourceUrl: url, userId: state.userId }),
    });
    setState({ jd, jdText: jd.rawText, jdFetching: false, jdFetchError: null });
    showToast("Job description fetched successfully!", "success");
  } catch (err) {
    const msg = err.message || String(err);
    setState({ jdFetching: false, jdFetchError: msg });
  }
}

async function submitResume({ file, pastedResume }) {
  if (!file && !pastedResume) {
    throw new Error("Please upload a resume file or paste resume text to begin.");
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
  const effectiveJdText = state.jdText.trim();

  if (state.jdMode === "url" && state.jd && effectiveJdText) {
    if (effectiveJdText === state.jd.rawText.trim()) {
      jd = state.jd;
    } else {
      jd = await api("/job-descriptions", {
        method: "POST",
        body: JSON.stringify({ rawText: effectiveJdText, userId: state.userId }),
      });
    }
  } else if (effectiveJdText) {
    jd = await api("/job-descriptions", {
      method: "POST",
      body: JSON.stringify({ rawText: effectiveJdText, userId: state.userId }),
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

// --------------------------------------------------------- Screen: Score

const SIGNAL_LABELS = {
  keyword_match: "Keyword Match",
  skills_alignment: "Skills Alignment",
  format_quality: "Format Quality",
  section_structure: "Section Structure",
  content_density: "Content Density",
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
  if (!score) return el(`<div class="panel">No score available.</div>`);

  const wrap = el(`<div></div>`);

  if (state.extraction && state.extraction.confidence !== "high") {
    const banner = el(`
      <div class="notice-banner" role="alert">
        <span>⚠️</span>
        <div>
          <strong>Extraction confidence: ${esc(state.extraction.confidence)}.</strong>
          <div>${esc(state.extraction.notes.join(" "))}</div>
        </div>
      </div>
    `);
    wrap.appendChild(banner);
  }

  // Score tiering
  const finalScore = score.final;
  const tierClass = finalScore >= 80 ? "tier-high" : finalScore >= 60 ? "tier-mid" : "tier-low";
  const tierLabel = finalScore >= 80 ? "✨ Strong Match" : finalScore >= 60 ? "⚡ Competitive" : "⚠️ Needs Optimization";

  // SVG Gauge calculations (radius = 54, circ = 2 * PI * 54 = 339.29)
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(100, Math.max(0, finalScore)) / 100) * circumference;

  const hero = el(`
    <div class="panel">
      <div class="score-hero-container">
        <div class="score-gauge">
          <svg viewBox="0 0 130 130">
            <circle class="score-gauge-bg" cx="65" cy="65" r="${radius}"></circle>
            <circle class="score-gauge-fill ${tierClass}" cx="65" cy="65" r="${radius}"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${offset}"></circle>
          </svg>
          <div class="score-gauge-inner">
            <div class="score-gauge-val">${finalScore}</div>
            <div class="score-gauge-max">/ 100</div>
          </div>
        </div>

        <div class="score-info">
          <div class="score-tier-badge ${tierClass}">${tierLabel}</div>
          <div class="score-meta-grid">
            <div class="score-meta-pill">Domain: <strong>${esc(score.domain)}</strong></div>
            <div class="score-meta-pill">Mode: <strong>${score.mode === "jd_targeted" ? "Targeted JD" : "Generic"}</strong></div>
            <div class="score-meta-pill" title="Recency multiplier based on job title / recency alignment">Recency Multiplier: <strong>x${score.recency_multiplier}</strong></div>
            <div class="score-meta-pill">Engine: <strong>${esc(score.engineVersion)}${score.semanticAvailable ? " · Semantic On" : ""}</strong></div>
          </div>
        </div>
      </div>

      <div class="bars">
        <h3 style="margin-bottom:12px; color:var(--text-muted);">Signal Breakdown</h3>
        ${Object.entries(SIGNAL_LABELS)
          .map(([key, label]) => {
            const value = score[key];
            const pct = Math.round(value * 100);
            const wt = Math.round(SIGNAL_WEIGHTS[key] * 100);
            const barTier = pct >= 75 ? "high" : pct >= 45 ? "mid" : "low";
            return `
              <div class="bar-row">
                <div class="bar-label">
                  ${esc(label)}
                  <span class="bar-weight">(${wt}% wt)</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill ${barTier}" style="width:${pct}%"></div>
                </div>
                <div class="bar-value">${pct}%</div>
              </div>`;
          })
          .join("")}
      </div>
    </div>
  `);
  wrap.appendChild(hero);

  // Skills Matrix
  if (score.matched_skills.length || score.missing_skills.length) {
    const skillsPanel = el(`
      <div class="panel">
        <h2>Skills Alignment Matrix</h2>
        <div class="skills-grid">
          ${score.matched_skills.length ? `
            <div>
              <h3 style="color:var(--good-light);">Matched Skills (${score.matched_skills.length})</h3>
              <div class="pill-list">${score.matched_skills.map((s) => `<span class="pill matched">✓ ${esc(s)}</span>`).join("")}</div>
            </div>
          ` : ""}
          ${score.missing_skills.length ? `
            <div>
              <h3 style="color:var(--warn-light); margin-top:8px;">Missing from Resume (${score.missing_skills.length})</h3>
              <div class="pill-list">${score.missing_skills.map((s) => `<span class="pill missing">+ ${esc(s)}</span>`).join("")}</div>
            </div>
          ` : ""}
        </div>
      </div>
    `);
    wrap.appendChild(skillsPanel);
  }

  // Human-Screening Graded Flags
  if (score.human_scan_flags_graded.length) {
    const flagsPanel = el(`
      <div class="panel">
        <h2>Human-Screening Review Flags</h2>
        <p class="hint" style="margin-top:-8px; margin-bottom:16px;">Evidence-graded audit checks. Solid badges are backed by empirical studies; dashed badges are advisory heuristics.</p>
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

  // Employment History / Knockouts
  if (score.knockouts.length) {
    const koPanel = el(`
      <div class="panel">
        <h2 style="color:var(--bad-light);">Employment History Flags</h2>
        ${score.knockouts.map((k) => `<div class="knockout">⚠️ ${esc(k)}</div>`).join("")}
      </div>
    `);
    wrap.appendChild(koPanel);
  }

  // Action Buttons
  const actions = el(`
    <div class="row" style="margin-top:24px;">
      <button id="find-gaps-btn" style="padding:12px 24px;" ${state.busy ? "disabled" : ""}>
        ${state.busy ? `<span class="loading-spinner"></span> Loading Suggestions...` : "✨ Review & Close Gaps →"}
      </button>
      <button class="secondary" id="start-over-btn">← Start Over</button>
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

// --------------------------------------------------- Screen: Suggestions

const GAP_TYPE_LABELS = {
  skill: "Missing Skill",
  metric: "Needs a Number",
  governance: "Formatting / Standard",
  phrasing: "Phrasing / Action Verb",
};

const GAP_QUESTIONS = {
  skill: "Have you actually done this in your work?",
  metric: "Do you know the approximate scale, volume, or metric for this?",
  governance: "Does this standard or requirement apply to your experience?",
  phrasing: "Does this describe work you actually performed?",
};

const RESPONSE_LABELS = {
  yes: "What did you do? In your own words (state scale, volume, and tools).",
  partial: "Describe the part of this you actually did.",
};

function renderSuggestionsScreen() {
  const wrap = el(`<div></div>`);

  const totalGaps = state.suggestions.length;
  const resolvedGaps = state.suggestions.filter((s) => s.status !== "suggested").length;
  const acceptedGaps = state.suggestions.filter((s) => s.status === "accepted" || s.status === "drafted" || s.status === "edited").length;
  const progressPct = totalGaps ? Math.round((resolvedGaps / totalGaps) * 100) : 100;

  const intro = el(`
    <div class="panel">
      <div class="panel-header-row">
        <div>
          <h2>Human-in-the-Loop Gap Closer</h2>
          <p class="hint" style="margin-top:2px;">
            Honest answers only — bullets are strictly drafted from what you write below (zero hallucination).
          </p>
        </div>
      </div>
      <div class="progress-summary-bar">
        <div>Progress: <strong>${resolvedGaps} of ${totalGaps}</strong> gaps reviewed (${acceptedGaps} accepted)</div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
    </div>
  `);
  wrap.appendChild(intro);

  if (!state.suggestions.length) {
    wrap.appendChild(el(`<div class="panel">No gaps found — your resume covers all criteria checked by the engine!</div>`));
  }

  for (const s of state.suggestions) {
    wrap.appendChild(renderSuggestionCard(s));
  }

  const acceptedCount = state.suggestions.filter((s) => s.status === "accepted").length;
  const autoEditNote = el(`
    <div class="panel" style="margin-top:24px; border-color:var(--border-accent);">
      <h3>Ready to build your optimized draft?</h3>
      <p class="hint" style="margin-bottom:16px;">
        This applies your accepted gap bullets and runs a safe auto-edit pass over existing bullets (rephrasing only, no invented facts) then re-scores the result.
      </p>
      <div class="row">
        <button id="build-draft-btn" style="padding:12px 24px;" ${state.busy ? "disabled" : ""}>
          ${state.busy ? `<span class="loading-spinner"></span> Building & Re-scoring...` : `🚀 Build Draft & Re-Score (${acceptedCount} Accepted)`}
        </button>
        <button class="secondary" id="back-to-score-btn">← Back to Score</button>
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
  const card = el(`<div class="panel card gap-${s.gapType}" data-id="${s.id}"></div>`);

  const head = el(`
    <div class="card-head">
      <div>
        <span class="gap-type-badge">${esc(GAP_TYPE_LABELS[s.gapType] || s.gapType)}</span>
        <div style="font-size:14.5px; font-weight:500; color:var(--text-bright); margin-top:2px;">
          ${esc(s.jdEvidence)}
          ${s.evidence ? " " + evidenceBadge(s.evidence) : ""}
        </div>
      </div>
      <div class="card-status ${s.status}">${esc(s.status.replace("_", " "))}</div>
    </div>
  `);
  card.appendChild(head);

  // ---- Study resources button (skill gaps only, studylinksplan.md §6) ----
  if (s.gapType === "skill") {
    const existingLinks = (ui.studyLinks !== undefined ? ui.studyLinks : s.studyLinks) || null;
    const loadingLinks = ui.loadingLinks || false;

    const resourcesWrap = el(`<div class="study-resources"></div>`);

    if (!existingLinks && !loadingLinks) {
      const findBtn = el(`
        <button class="study-resources-btn" data-action="find-resources" ${state.busy ? "disabled" : ""}>
          🎓 Find Study Resources
        </button>
      `);
      findBtn.addEventListener("click", () => {
        state.cardUi[s.id] = { ...ui, loadingLinks: true };
        render();
        guarded(() => fetchStudyLinks(s.id));
      });
      resourcesWrap.appendChild(findBtn);
    } else if (loadingLinks) {
      resourcesWrap.innerHTML = `<span class="study-resources-loading"><span class="loading-spinner"></span> Finding resources…</span>`;
    } else if (existingLinks && existingLinks.length > 0) {
      const list = el(`<div class="study-links-list"></div>`);
      for (const link of existingLinks) {
        const linkCard = el(`
          <a class="study-link-card" href="${esc(link.url)}" target="_blank" rel="noopener">
            ${link.thumbnailUrl ? `<img class="study-link-thumb" src="${esc(link.thumbnailUrl)}" alt="" loading="lazy">` : `<div class="study-link-thumb study-link-thumb--placeholder">▶</div>`}
            <div class="study-link-info">
              <div class="study-link-title">${esc(link.title)}</div>
              <div class="study-link-channel">${esc(link.channelTitle)}</div>
            </div>
          </a>
        `);
        list.appendChild(linkCard);
      }
      resourcesWrap.appendChild(list);
    }
    card.appendChild(resourcesWrap);
  }

  if (s.status === "suggested") {
    const question = GAP_QUESTIONS[s.gapType] || "Do you have this experience?";
    const responder = el(`
      <div>
        <p class="confidence-question" id="q-${s.id}">${esc(question)}</p>
        <div class="confidence-buttons" role="group" aria-labelledby="q-${s.id}">
          <button data-level="yes" aria-pressed="${ui.level === "yes"}" class="${ui.level === "yes" ? "is-selected" : ""}" ${state.busy ? "disabled" : ""}>
            ✓ Yes — I've done this
          </button>
          <button data-level="partial" aria-pressed="${ui.level === "partial"}" class="${ui.level === "partial" ? "is-selected" : ""}" ${state.busy ? "disabled" : ""}>
            ⚡ Some of it
          </button>
        </div>
        <div class="confidence-buttons confidence-skip">
          <button data-level="no" ${state.busy ? "disabled" : ""}>✕ No — skip this gap</button>
        </div>
        ${
          ui.responding
            ? `
            <div class="field" style="margin-top:14px;">
              <label>${esc(RESPONSE_LABELS[ui.level] || "Describe it in your own words")}</label>
              <textarea id="input-${s.id}" placeholder="What did you actually do? Be specific with numbers, tools, or scope — this is the only source of fact."></textarea>
            </div>
            <button data-action="submit-response" style="margin-top:4px;">✨ Generate Bullet Draft</button>`
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

    if (ui.responding) {
      queueMicrotask(() => document.getElementById(`input-${s.id}`)?.focus());
    }

    const submitBtn = responder.querySelector('[data-action="submit-response"]');
    if (submitBtn) {
      submitBtn.addEventListener("click", () => {
        const text = document.getElementById(`input-${s.id}`).value.trim();
        if (!text) {
          showToast("Please write a brief description of what you did first.", "error");
          return;
        }
        guarded(() => respondSuggestion(s.id, ui.level, text));
      });
    }
    card.appendChild(responder);
  }

  if (s.status === "user_responded") {
    if (s.validationError) {
      const warn = el(`<div class="notice-banner"><span>⚠️</span><div>${esc(s.validationError)}</div></div>`);
      card.appendChild(warn);
      const retry = el(`
        <div>
          <div class="field"><label>Add more specific details</label><textarea id="retry-${s.id}">${esc(s.userInput || "")}</textarea></div>
          <button data-action="retry">Try drafting again</button>
        </div>
      `);
      retry.querySelector("[data-action='retry']").addEventListener("click", () => {
        const text = document.getElementById(`retry-${s.id}`).value.trim();
        guarded(() => retryDraft(s.id, text));
      });
      card.appendChild(retry);
    } else {
      card.appendChild(el(`<div style="padding:14px 0; color:var(--text-muted);"><span class="loading-spinner"></span> Drafting bullet with guardrails...</div>`));
    }
  }

  if (s.status === "drafted" || s.status === "edited") {
    const draftBox = el(`
      <div>
        <div class="draft-box">
          <div class="draft-label">Drafted Bullet Suggestion</div>
          <div id="draft-text-${s.id}">${esc(s.draftBullet || "")}</div>
        </div>
        ${s.unquantifiedGaps.length ? `<div class="gap-note">⚠️ Note: ${esc(s.unquantifiedGaps.join(" "))}</div>` : ""}
        <div class="row" style="margin-top:12px">
          <button class="success" data-action="accept">✓ Accept Bullet</button>
          <button class="secondary" data-action="edit">✏️ Edit</button>
          <button class="secondary" data-action="decline">✕ Decline</button>
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
      target.outerHTML = `<textarea id="edit-${s.id}" style="margin-top:6px;">${esc(s.draftBullet || "")}</textarea><button data-action="save-edit" style="margin-top:10px;">Save Edit</button>`;
      draftBox.querySelector("[data-action='save-edit']").addEventListener("click", () => {
        const text = document.getElementById(`edit-${s.id}`).value.trim();
        guarded(() => saveEdit(s.id, text));
      });
    });
    card.appendChild(draftBox);
  }

  if (s.status === "accepted") {
    const box = el(`
      <div class="draft-box" style="border-color:var(--good-border);">
        <div class="draft-label" style="color:var(--good-light);">✓ Accepted Bullet</div>
        <div>${esc(s.draftBullet || "")}</div>
      </div>
    `);
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
  if (confidenceLevel === "no") {
    showToast("Gap skipped", "info");
  } else {
    showToast("Bullet drafted successfully!", "success");
  }
}

async function fetchStudyLinks(id) {
  try {
    const updated = await api(`/suggestions/${id}/study-links`, { method: "POST" });
    replaceSuggestion(updated);
    const currentUi = state.cardUi[id] || {};
    state.cardUi[id] = { ...currentUi, loadingLinks: false, studyLinks: updated.studyLinks };
    showToast("Study resources loaded!", "success");
  } catch (err) {
    const currentUi = state.cardUi[id] || {};
    state.cardUi[id] = { ...currentUi, loadingLinks: false };
    throw err;
  }
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
  showToast("Bullet accepted for draft", "success");
}

async function declineCard(id) {
  const updated = await api(`/suggestions/${id}/decline`, { method: "POST" });
  replaceSuggestion(updated);
  showToast("Suggestion declined", "info");
}

async function saveEdit(id, text) {
  const updated = await api(`/suggestions/${id}/edit`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  replaceSuggestion(updated);
  showToast("Edit saved", "success");
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
  showToast("Draft built and re-scored!", "success");
}

// --------------------------------------------------------- Screen: Draft

function renderDraftScreen() {
  const wrap = el(`<div></div>`);
  const r = state.rescore;

  if (r) {
    const deltaClass = r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat";
    const sign = r.delta > 0 ? "+" : "";
    const summary = el(`
      <div class="rescore-hero-card">
        <h2>Draft Re-Scoring Results</h2>
        <div class="rescore-comparison">
          <div class="rescore-box">
            <div class="rescore-box-label">Initial Score</div>
            <div class="rescore-box-val">${r.before.final}</div>
          </div>
          <div class="rescore-arrow">→</div>
          <div class="rescore-box">
            <div class="rescore-box-label">Rescored Draft</div>
            <div class="rescore-box-val" style="color:var(--good-light);">${r.after.final}</div>
          </div>
          <div class="delta-badge ${deltaClass}">
            <span>${sign}${r.delta} Points</span>
          </div>
        </div>
        ${
          r.comparability && r.comparability.length
            ? `<div class="notice-banner" style="margin-top:16px;"><span>ℹ</span><div>${esc(r.comparability.join("; "))}</div></div>`
            : ""
        }
      </div>
    `);
    wrap.appendChild(summary);
  }

  if (state.draft) {
    const bulletsPanel = el(`
      <div class="panel">
        <div class="panel-header-row">
          <h2>Bullet Modifications (Before / After)</h2>
          <div class="row">
            <button class="secondary" id="copy-bullets-btn" style="font-size:13px; padding:6px 14px;">
              📋 Copy All Bullets
            </button>
            <button class="secondary" id="download-txt-btn" style="font-size:13px; padding:6px 14px;">
              💾 Download (.txt)
            </button>
          </div>
        </div>
      </div>
    `);

    for (const b of state.draft.bullets) {
      const row = el(`
        <div class="bullet-diff">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div class="origin-tag">${esc(b.origin.replace("_", " "))}</div>
            <button class="ghost copy-single-btn" data-text="${esc(b.finalText)}" style="font-size:12px; padding:2px 6px;">Copy</button>
          </div>
          ${b.originalText && b.originalText !== b.finalText ? `<div class="before">${esc(b.originalText)}</div>` : ""}
          <div class="after">${esc(b.finalText)}</div>
          ${b.changesMade.length ? `<div class="changes-pill">⚡ ${esc(b.changesMade.join("; "))}</div>` : ""}
        </div>
      `);

      row.querySelector(".copy-single-btn").addEventListener("click", (e) => {
        const text = e.target.getAttribute("data-text");
        navigator.clipboard.writeText(text).then(() => {
          showToast("Bullet copied to clipboard!", "success");
        });
      });

      bulletsPanel.appendChild(row);
    }

    bulletsPanel.querySelector("#copy-bullets-btn").addEventListener("click", () => {
      const allText = state.draft.bullets.map((b) => `• ${b.finalText}`).join("\n");
      navigator.clipboard.writeText(allText).then(() => {
        showToast("All improved bullets copied to clipboard!", "success");
      });
    });

    bulletsPanel.querySelector("#download-txt-btn").addEventListener("click", () => {
      const allText = state.draft.bullets.map((b) => `• ${b.finalText}`).join("\n");
      const blob = new Blob([allText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "optimized-resume-bullets.txt";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Downloaded optimized-resume-bullets.txt", "success");
    });

    wrap.appendChild(bulletsPanel);
  }

  const actions = el(`
    <div class="row" style="margin-top:24px;">
      <button class="secondary" id="back-to-suggestions-btn">← Back to Suggestions</button>
      <button class="secondary" id="start-over-btn">Start Over with a New Resume</button>
    </div>
  `);
  actions.querySelector("#back-to-suggestions-btn").addEventListener("click", () => setState({ screen: "suggestions" }));
  actions.querySelector("#start-over-btn").addEventListener("click", () =>
    setState({
      screen: "upload",
      resume: null,
      resumeFileName: null,
      selectedFile: null,
      bullets: [],
      extraction: null,
      jd: null,
      score: null,
      suggestions: [],
      draft: null,
      rescore: null,
      cardUi: {},
      jdMode: "paste",
      jdUrl: "",
      jdText: "",
      jdFetching: false,
      jdFetchError: null,
    })
  );
  wrap.appendChild(actions);

  return wrap;
}

// ------------------------------------------------------------------ Init

render();
loadConfig();
