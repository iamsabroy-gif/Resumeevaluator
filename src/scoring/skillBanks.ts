/**
 * Seed skill banks.
 *
 * Fifteen domains. `payments` is the reference bank — deepest skill list and
 * fully grouped — and the others follow its shape at lower depth.
 *
 * Two rules the engine depends on:
 *  - Every `skills` entry is lowercase. `scoreSkillsAlignment` does a
 *    case-insensitive substring test by lowercasing the resume and the JD and
 *    comparing against the raw bank term, so an uppercase bank entry can
 *    never match.
 *  - `generic` has an empty `detect_terms` array. `resolveDomain` skips banks
 *    with no detect terms, which is what makes generic the fallback that can
 *    never auto-win detection.
 */

import type { SkillBank } from "../engine/ats-scorer.js";

function flatten(groups: Record<string, string[]>): string[] {
  return Array.from(new Set(Object.values(groups).flat())).sort();
}

const paymentsGroups: Record<string, string[]> = {
  rails_and_schemes: [
    "ach", "sepa", "sepa instant", "faster payments", "chaps", "bacs", "swift",
    "iso 20022", "rtp", "fedwire", "fednow", "upi", "imps", "neft", "rtgs",
    "card scheme", "visa", "mastercard", "amex", "interchange", "wire transfer",
    "cross-border payments", "correspondent banking",
  ],
  processing: [
    "payment gateway", "acquiring", "issuing", "authorization", "capture",
    "settlement", "clearing", "reconciliation", "chargeback", "dispute",
    "refund", "payout", "merchant onboarding", "tokenization", "3ds",
    "3d secure", "sca", "psd2", "payment orchestration", "routing",
  ],
  risk_and_compliance: [
    "aml", "kyc", "kyb", "cdd", "edd", "sanctions screening", "pci dss",
    "fraud detection", "transaction monitoring", "chargeback ratio",
    "risk scoring", "regulatory reporting", "sar", "fatf", "gdpr",
    "audit", "sox", "financial crime",
  ],
  platforms: [
    "stripe", "adyen", "paypal", "braintree", "checkout.com", "worldpay",
    "fiserv", "marqeta", "plaid", "razorpay", "payu", "square",
  ],
  data_and_tooling: [
    "sql", "python", "java", "kafka", "airflow", "looker", "tableau",
    "double-entry", "ledger", "general ledger", "api integration", "webhooks",
    "rest api", "idempotency",
  ],
  commercial: [
    "p&l", "unit economics", "take rate", "authorization rate", "approval rate",
    "cost per transaction", "gtv", "tpv", "churn", "sla", "vendor management",
    "stakeholder management", "roadmap",
  ],
};

export const SKILL_BANKS: SkillBank[] = [
  {
    domain: "payments",
    display_name: "Payments & Fintech",
    detect_terms: [
      "payment", "payments", "acquiring", "issuing", "settlement", "chargeback",
      "interchange", "merchant", "psp", "iso 20022", "aml", "kyc", "fintech",
      "card scheme", "transaction monitoring", "payout",
    ],
    skill_groups: paymentsGroups,
    skills: flatten(paymentsGroups),
  },
  {
    domain: "software_engineering",
    display_name: "Software Engineering",
    detect_terms: [
      "software engineer", "backend", "frontend", "full stack", "full-stack",
      "api", "microservices", "developer", "codebase", "distributed systems",
    ],
    skill_groups: {
      languages: ["typescript", "javascript", "python", "java", "go", "rust", "c#", "kotlin", "scala", "ruby"],
      frameworks: ["react", "node.js", "express", "spring boot", "django", "fastapi", ".net", "next.js", "graphql", "grpc"],
      practices: ["microservices", "rest api", "unit testing", "code review", "ci/cd", "tdd", "design patterns", "system design", "agile", "scrum"],
      data: ["postgresql", "mysql", "mongodb", "redis", "kafka", "elasticsearch", "sql"],
      platform: ["docker", "kubernetes", "aws", "gcp", "azure", "terraform", "git"],
    },
    skills: [],
  },
  {
    domain: "data_engineering",
    display_name: "Data Engineering",
    detect_terms: [
      "data engineer", "etl", "elt", "data pipeline", "data warehouse",
      "data lake", "ingestion", "batch processing", "streaming",
    ],
    skill_groups: {
      pipelines: ["airflow", "dbt", "dagster", "luigi", "prefect", "etl", "elt", "data pipeline", "orchestration"],
      storage: ["snowflake", "bigquery", "redshift", "databricks", "delta lake", "s3", "data warehouse", "data lake"],
      processing: ["spark", "flink", "kafka", "kinesis", "hadoop", "beam", "streaming", "batch processing"],
      languages: ["python", "sql", "scala", "java", "bash"],
      quality: ["data quality", "data governance", "lineage", "great expectations", "schema evolution", "partitioning"],
    },
    skills: [],
  },
  {
    domain: "data_science",
    display_name: "Data Science & Machine Learning",
    detect_terms: [
      "data scientist", "machine learning", "ml engineer", "predictive model",
      "statistical", "deep learning", "nlp", "model training",
    ],
    skill_groups: {
      modelling: ["regression", "classification", "clustering", "time series", "deep learning", "nlp", "computer vision", "recommender", "feature engineering", "a/b testing"],
      tooling: ["python", "r", "pandas", "numpy", "scikit-learn", "pytorch", "tensorflow", "xgboost", "jupyter", "mlflow"],
      deployment: ["mlops", "model monitoring", "feature store", "model serving", "sagemaker", "vertex ai"],
      analysis: ["sql", "hypothesis testing", "statistical significance", "experiment design", "causal inference", "data visualization"],
    },
    skills: [],
  },
  {
    domain: "product_management",
    display_name: "Product Management",
    detect_terms: [
      "product manager", "product owner", "roadmap", "product strategy",
      "user stories", "backlog", "go-to-market", "product discovery",
    ],
    skill_groups: {
      strategy: ["product strategy", "roadmap", "market research", "competitive analysis", "positioning", "go-to-market", "pricing", "business case"],
      delivery: ["backlog", "user stories", "prd", "agile", "scrum", "sprint planning", "prioritization", "stakeholder management"],
      discovery: ["user research", "customer interviews", "usability testing", "product discovery", "jobs to be done", "persona"],
      measurement: ["kpi", "okr", "a/b testing", "analytics", "retention", "activation", "funnel analysis", "sql", "amplitude", "mixpanel"],
    },
    skills: [],
  },
  {
    domain: "cybersecurity",
    display_name: "Cybersecurity",
    detect_terms: [
      "security engineer", "cybersecurity", "infosec", "threat", "vulnerability",
      "penetration testing", "soc analyst", "incident response",
    ],
    skill_groups: {
      defensive: ["siem", "soc", "incident response", "threat detection", "threat hunting", "edr", "dlp", "log analysis", "splunk"],
      offensive: ["penetration testing", "vulnerability assessment", "red team", "burp suite", "metasploit", "owasp"],
      governance: ["iso 27001", "nist", "soc 2", "risk assessment", "security audit", "compliance", "gdpr", "security policy"],
      technical: ["encryption", "pki", "iam", "zero trust", "firewall", "network security", "application security", "python"],
    },
    skills: [],
  },
  {
    domain: "devops_sre",
    display_name: "DevOps & Site Reliability",
    detect_terms: [
      "devops", "site reliability", "sre", "platform engineer", "ci/cd",
      "infrastructure as code", "on-call", "observability",
    ],
    skill_groups: {
      automation: ["terraform", "ansible", "pulumi", "cloudformation", "infrastructure as code", "ci/cd", "jenkins", "github actions", "gitlab ci", "argocd"],
      runtime: ["kubernetes", "docker", "helm", "service mesh", "istio", "containerd", "linux"],
      reliability: ["observability", "prometheus", "grafana", "datadog", "slo", "sli", "error budget", "incident management", "on-call", "postmortem", "chaos engineering"],
      cloud: ["aws", "gcp", "azure", "networking", "load balancing", "autoscaling", "cost optimization"],
    },
    skills: [],
  },
  {
    domain: "cloud_infrastructure",
    display_name: "Cloud & Infrastructure",
    detect_terms: [
      "cloud architect", "cloud migration", "infrastructure", "solutions architect",
      "landing zone", "well-architected",
    ],
    skill_groups: {
      providers: ["aws", "gcp", "azure", "ec2", "lambda", "s3", "vpc", "eks", "gke", "aks"],
      architecture: ["cloud migration", "landing zone", "multi-region", "disaster recovery", "high availability", "cost optimization", "well-architected", "serverless"],
      networking: ["dns", "cdn", "load balancing", "vpn", "firewall", "networking", "tls"],
      governance: ["iam", "tagging", "finops", "compliance", "security baseline", "terraform"],
    },
    skills: [],
  },
  {
    domain: "qa_testing",
    display_name: "QA & Test Engineering",
    detect_terms: [
      "qa engineer", "test engineer", "quality assurance", "test automation",
      "sdet", "regression testing", "test plan",
    ],
    skill_groups: {
      automation: ["selenium", "cypress", "playwright", "appium", "test automation", "webdriver", "rest assured"],
      practice: ["test plan", "test case", "regression testing", "smoke testing", "exploratory testing", "uat", "defect tracking", "jira"],
      performance: ["jmeter", "load testing", "performance testing", "k6", "stress testing"],
      technical: ["sql", "python", "java", "javascript", "ci/cd", "api testing", "postman"],
    },
    skills: [],
  },
  {
    domain: "finance_accounting",
    display_name: "Finance & Accounting",
    detect_terms: [
      "financial analyst", "accounting", "fp&a", "controller", "audit",
      "financial reporting", "budgeting", "forecasting",
    ],
    skill_groups: {
      reporting: ["financial reporting", "ifrs", "gaap", "month-end close", "general ledger", "reconciliation", "consolidation", "variance analysis"],
      planning: ["fp&a", "budgeting", "forecasting", "financial modelling", "financial modeling", "scenario analysis", "cash flow"],
      controls: ["sox", "internal controls", "audit", "compliance", "risk management", "tax"],
      tooling: ["excel", "sap", "oracle", "netsuite", "quickbooks", "power bi", "tableau", "sql"],
    },
    skills: [],
  },
  {
    domain: "marketing",
    display_name: "Marketing & Growth",
    detect_terms: [
      "marketing manager", "growth marketing", "demand generation", "seo",
      "content marketing", "brand", "campaign", "paid media",
    ],
    skill_groups: {
      channels: ["seo", "sem", "paid media", "ppc", "google ads", "meta ads", "email marketing", "content marketing", "social media", "affiliate"],
      analytics: ["google analytics", "attribution", "conversion rate", "cac", "ltv", "a/b testing", "funnel analysis", "roas"],
      craft: ["copywriting", "brand strategy", "positioning", "campaign management", "marketing automation", "hubspot", "marketo", "crm"],
      growth: ["demand generation", "lead generation", "lifecycle marketing", "retention", "product marketing", "gtm"],
    },
    skills: [],
  },
  {
    domain: "sales",
    display_name: "Sales & Business Development",
    detect_terms: [
      "account executive", "sales manager", "business development", "quota",
      "pipeline", "prospecting", "enterprise sales", "account management",
    ],
    skill_groups: {
      process: ["prospecting", "lead qualification", "discovery call", "demo", "negotiation", "closing", "pipeline management", "forecasting"],
      methodology: ["meddic", "spin selling", "challenger sale", "solution selling", "consultative selling", "value selling"],
      accounts: ["account management", "upsell", "cross-sell", "renewal", "churn", "customer success", "relationship building"],
      tooling: ["salesforce", "hubspot", "outreach", "crm", "linkedin sales navigator", "quota attainment"],
    },
    skills: [],
  },
  {
    domain: "hr_recruiting",
    display_name: "HR & Talent Acquisition",
    detect_terms: [
      "recruiter", "talent acquisition", "human resources", "hr business partner",
      "onboarding", "employee relations", "sourcing",
    ],
    skill_groups: {
      hiring: ["sourcing", "screening", "interview", "candidate experience", "offer negotiation", "employer branding", "ats", "boolean search"],
      operations: ["onboarding", "offboarding", "hris", "workday", "payroll", "benefits administration", "compensation"],
      people: ["employee relations", "performance management", "learning and development", "engagement survey", "succession planning", "dei"],
      compliance: ["employment law", "gdpr", "policy", "workforce planning", "hr analytics"],
    },
    skills: [],
  },
  {
    domain: "healthcare",
    display_name: "Healthcare & Clinical",
    detect_terms: [
      "clinical", "patient care", "healthcare", "nursing", "hipaa",
      "electronic health record", "ehr", "medical",
    ],
    skill_groups: {
      clinical: ["patient care", "clinical assessment", "care plan", "triage", "medication administration", "vital signs", "patient safety"],
      systems: ["ehr", "emr", "epic", "cerner", "hl7", "fhir", "medical coding", "icd-10", "cpt"],
      compliance: ["hipaa", "clinical governance", "quality improvement", "infection control", "accreditation", "joint commission"],
      operations: ["scheduling", "case management", "utilization review", "discharge planning", "interdisciplinary team"],
    },
    skills: [],
  },
  {
    // Fallback bank. Empty detect_terms is load-bearing: resolveDomain skips
    // banks with no detect terms, so generic is only ever reached by falling
    // through, never by winning detection.
    domain: "generic",
    display_name: "General / Cross-functional",
    detect_terms: [],
    skill_groups: {
      core: ["project management", "stakeholder management", "communication", "leadership", "problem solving", "process improvement", "reporting", "budgeting", "training", "documentation"],
      tooling: ["excel", "powerpoint", "sql", "jira", "confluence", "power bi", "tableau"],
    },
    skills: [],
  },
];

// Fill in `skills` for every bank that declared groups but left skills empty.
for (const bank of SKILL_BANKS) {
  if (bank.skills.length === 0 && bank.skill_groups) {
    bank.skills = flatten(bank.skill_groups);
  }
}

// Guard the lowercase invariant at module load rather than letting a bad
// entry silently never match at scoring time.
for (const bank of SKILL_BANKS) {
  const bad = bank.skills.filter((s) => s !== s.toLowerCase());
  if (bad.length) {
    throw new Error(
      `Skill bank "${bank.domain}" has non-lowercase skills: ${bad.join(", ")}`
    );
  }
}

export function bankByDomain(domain: string): SkillBank {
  const found = SKILL_BANKS.find((b) => b.domain === domain);
  if (found) return found;
  const generic = SKILL_BANKS.find((b) => b.domain === "generic");
  if (!generic) throw new Error("generic skill bank missing");
  return generic;
}
