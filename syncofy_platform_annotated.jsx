/**
 * ============================================================================
 * SYNCOFY ENGAGEMENT AI PLATFORM — ANNOTATED SOURCE
 * ============================================================================
 *
 * WHAT THIS FILE IS:
 *   A single-file React application that serves as the full Syncofy product
 *   experience: marketing overview, live KOL database, AI chat, and a 4-step
 *   sales onboarding flow (profile → services → legal → payment confirmation).
 *
 * THREE MERGED SYSTEMS:
 *   1. ANCO 2026 Platform  — Sales flow, NPI verification, legal acknowledgments,
 *                            Stripe payment, user-type routing (pharma vs physician)
 *   2. Supabase AI Engine  — Live PostgREST queries to mv_provider_intelligence
 *                            (8,953 providers), Edge Function proxy for Claude API
 *   3. KOL X Leaderboard   — Paginated, filterable provider rankings with freemium gates
 *
 * DEPLOYMENT:
 *   - Host as a React component (Vite, CRA, Netlify, Vercel)
 *   - OR embed in the existing kolx.syncofy.ai static site via a /app route
 *   - Requires no backend — all data flows through Supabase REST + Edge Functions
 *
 * DEPENDENCIES (no npm installs needed beyond React):
 *   - React 18+ (useState, useEffect, useRef, useCallback)
 *   - Supabase PostgREST (direct HTTP, no supabase-js client needed)
 *   - Anthropic Claude API (via Supabase Edge Function proxy — see CLAUDE_PROXY)
 *   - Google Fonts (DM Sans + JetBrains Mono — loaded via @import in inline <style>)
 *
 * FILE STRUCTURE:
 *   1. Config & credentials      (lines ~30–50)
 *   2. Supabase query helpers    (lines ~55–100)
 *   3. Design system constants   (lines ~105–160)
 *   4. AI system prompt          (lines ~165–185)
 *   5. Data constants            (lines ~190–280)
 *   6. Shared UI components      (lines ~285–360)
 *   7. Main app + state          (lines ~365–460)
 *   8. HOME view                 (lines ~465–570)
 *   9. LEADERBOARD view          (lines ~575–640)
 *  10. SALES FLOW views          (lines ~645–735)
 *
 * OPEN ITEMS (pre-launch checklist):
 *   [ ] Replace STRIPE_LINKS test URLs with real Stripe Payment Link IDs
 *   [ ] Confirm Supabase RLS allows anon reads on mv_provider_intelligence
 *   [ ] Verify claude-proxy Edge Function is deployed + ANTHROPIC_API_KEY set
 *   [ ] Replace NDA/MSA/COI summaries with final executed document language
 *   [ ] Wire Step 3 legal capture to a Supabase insert (table: engagement_leads)
 *   [ ] Add GA4 event tracking on salesStep transitions + Stripe click
 *
 * CONTACT: info@syncofy.ai · Jason Yonehiro, Founder & CEO
 * ============================================================================
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── 1. CONFIG & CREDENTIALS ───────────────────────────────────────────────────
//
// SUPABASE_URL:   Your project's REST endpoint. Never changes for this project.
// SUPABASE_ANON:  Public anon key — safe to expose in frontend code. Row-Level
//                 Security (RLS) policies on Supabase enforce what this key can
//                 read/write. Confirm anon SELECT is enabled on mv_provider_intelligence.
// CLAUDE_PROXY:   Supabase Edge Function that forwards requests to Anthropic's
//                 /v1/messages endpoint. Keeps ANTHROPIC_API_KEY server-side so
//                 it never appears in client bundles. Deployed as:
//                   supabase functions deploy claude-proxy
//                 CORS is handled in the Edge Function — direct Anthropic calls
//                 from the browser WILL fail (403) because Anthropic blocks browser
//                 origins. Always route through this proxy.
//
const SUPABASE_URL  = 'https://vdweyrjafrlnvqkztlrz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_KA7Z6v1gPgXEqcDsjeoiyw_qf1GejsQ';
const CLAUDE_PROXY  = 'https://vdweyrjafrlnvqkztlrz.supabase.co/functions/v1/claude-proxy';


// ── 2. SUPABASE QUERY HELPERS ─────────────────────────────────────────────────

/**
 * sbQuery — thin wrapper around Supabase PostgREST
 *
 * Takes a pre-built PostgREST query string (path + filters), attaches auth
 * headers, and returns parsed JSON. Throws on non-200 so callers can catch.
 *
 * WHY NOT USE supabase-js?
 *   The supabase-js client adds ~70KB to the bundle. For a single materialized
 *   view with well-known filters, direct HTTP is lighter and equally fast.
 *
 * @param {string} path  - PostgREST path + query string, e.g.
 *                         "mv_provider_intelligence?select=id,npi&limit=20"
 * @returns {Promise<Array>} - Parsed JSON array from PostgREST
 */
async function sbQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey:        SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

/**
 * buildKolQuery — constructs a PostgREST filter string for provider searches
 *
 * SOURCE TABLE: mv_provider_intelligence (materialized view)
 *   - Refreshed nightly from the providers base table + enrichment joins
 *   - 8,953+ records as of Feb 2026
 *   - Key fields: npi, first_name, last_name, credentials, institution_name,
 *     city, state, kol_tier, kol_score, publications_count, h_index,
 *     clinical_trials_count, disease_focus (jsonb array), ash_presenter,
 *     asco_presenter, is_active
 *
 * FILTER NOTES:
 *   - disease_focus is a JSONB array column → use PostgREST `cs` (contains)
 *     operator: disease_focus=cs.{"AML"} means "array contains 'AML'"
 *   - kol_tier is an enum: tier_1_national | tier_2_regional | tier_3_local |
 *     rising_star | unclassified
 *   - Results are sorted by kol_score descending (nulls last) so top KOLs
 *     always appear first regardless of filters
 *
 * @param {Object} opts
 * @param {string|null} opts.name         - Partial name match (ilike on first + last)
 * @param {string|null} opts.tier         - Exact kol_tier enum value
 * @param {string|null} opts.disease      - Exact disease string inside jsonb array
 * @param {string|null} opts.institution  - Partial institution_name match (ilike)
 * @param {number}      opts.limit        - Max rows (default 20, max 100 before perf degrades)
 * @param {number}      opts.offset       - Pagination offset (page * limit)
 * @returns {string} - PostgREST path + query string ready for sbQuery()
 */
function buildKolQuery({ name, tier, disease, institution, limit = 20, offset = 0 }) {
  // Select only the fields needed for KolCard rendering — avoids pulling heavy
  // text fields (bio, notes) that aren't displayed in list view.
  let q = `mv_provider_intelligence?select=id,npi,first_name,last_name,credentials,institution_name,city,state,kol_tier,kol_score,publications_count,h_index,clinical_trials_count,disease_focus,ash_presenter,asco_presenter,is_active&is_active=eq.true&order=kol_score.desc.nullslast&limit=${limit}&offset=${offset}`;

  // Name: OR across first_name and last_name using ilike (case-insensitive partial)
  if (name)        q += `&or=(first_name.ilike.*${name}*,last_name.ilike.*${name}*)`;

  // Tier: exact enum match — values defined in TIER_LABELS below
  if (tier)        q += `&kol_tier=eq.${tier}`;

  // Institution: case-insensitive partial match on institution_name
  if (institution) q += `&institution_name=ilike.*${institution}*`;

  // Disease: JSONB array containment — PostgREST `cs` operator
  // IMPORTANT: wrap value in {"..."} — PostgREST expects a JSON array literal
  if (disease)     q += `&disease_focus=cs.{"${disease}"}`;

  return q;
}

/**
 * detectIntent — extracts structured filters from a free-text chat query
 *
 * Used before every AI chat message to pre-fetch relevant KOL records from
 * Supabase and inject them as live context into the Claude API call. This is
 * the "retrieval" step in a lightweight RAG (Retrieval-Augmented Generation)
 * pattern — the AI doesn't hallucinate KOL names because real rows are
 * passed in the system context.
 *
 * DETECTION LOGIC:
 *   - Disease: keyword dictionary with aliases (e.g. "acute myeloid" → "AML")
 *   - Institution: exact phrase match against known major centers
 *   - Tier: keyword match ("tier 1", "national", "rising", "emerging")
 *   - Name: regex captures text after "find / show / who is / about" + optional "Dr."
 *
 * LIMITATIONS:
 *   - Doesn't handle multi-disease queries ("AML and MDS KOLs")
 *   - Name capture stops at 2 words — won't match "Maria Teresa Rodriguez"
 *   - No semantic similarity — if user types "leukemia" it won't match "AML"
 *     unless "leukemia" is added to the aliases dict
 *
 * @param {string} q - Raw user chat input
 * @returns {{ disease, institution, tier, name }} - All fields nullable
 */
function detectIntent(q) {
  const t = q.toLowerCase();

  // Disease aliases — add new ones here as indications expand
  const diseases = {
    'AML':              ['aml','acute myeloid'],
    'DLBCL':            ['dlbcl','diffuse large b','large b-cell'],
    'Multiple Myeloma': ['myeloma'],
    'CLL':              ['cll','chronic lymphocytic'],
    'Lymphoma':         ['lymphoma','nhl'],
    'MDS':              ['mds','myelodysplastic'],
    'CAR-T':            ['car-t','cart'],
    'Myelofibrosis':    ['myelofibrosis'],
  };

  // Major centers — add new ones as the DB expands to GU / cardiometabolic
  const insts = {
    'MD Anderson':         'md anderson',
    'Memorial Sloan Kettering': 'memorial sloan',
    'Mayo Clinic':         'mayo',
    'Dana-Farber':         'dana-farber',
    'City of Hope':        'city of hope',
    'Stanford':            'stanford',
    'Fred Hutch':          'fred hutch',
    'UCSF':                'ucsf',
  };

  let disease = null, institution = null, tier = null;
  for (const [k, v] of Object.entries(diseases)) if (v.some(x => t.includes(x))) { disease = k; break; }
  for (const [k, v] of Object.entries(insts))    if (t.includes(v))              { institution = k; break; }

  if (t.includes('tier 1') || t.includes('national'))  tier = 'tier_1_national';
  if (t.includes('tier 2') || t.includes('regional'))  tier = 'tier_2_regional';
  if (t.includes('rising') || t.includes('emerging'))  tier = 'rising_star';

  // Name capture: grabs up to 2 words after trigger phrases and "Dr."
  const nm = t.match(/(?:find|show|who is|profile of|tell me about|about)\s+(?:dr\.?\s+)?([a-z]+(?: [a-z]+)?)/i);
  return { disease, institution, tier, name: nm?.[1] || null };
}


// ── 3. DESIGN SYSTEM ──────────────────────────────────────────────────────────
//
// C — color token map for the Syncofy dark-mode design system.
// All inline styles reference C.xxx rather than hardcoding hex values,
// making global color changes a single-line edit here.
//
// BRAND PALETTE:
//   indigo  #6366F1  — Primary CTAs, tier badges, active states, AI elements
//   teal    #00C2A8  — Data highlights, success states, DB status indicator
//   bg      #08091A  — Page background (near-black, slightly blue)
//   surface #0E1220  — Panel backgrounds (slightly lighter than bg)
//   card    #131929  — Card / input backgrounds
//   border  #1A2340  — All borders and dividers
//   text    #EDF2FF  — Primary readable text
//   muted   #7A8599  — Secondary labels, metadata, placeholder text
//
const C = {
  bg:       "#08091A",
  surface:  "#0E1220",
  card:     "#131929",
  border:   "#1A2340",
  indigo:   "#6366F1",
  teal:     "#00C2A8",
  indigoDim:"rgba(99,102,241,0.15)",   // Used for AI chat bubbles, active pills
  tealDim:  "rgba(0,194,168,0.12)",    // Subtle teal tint backgrounds
  text:     "#EDF2FF",
  muted:    "#7A8599",
  success:  "#10B981",
  warn:     "#F59E0B",
  danger:   "#EF4444",
};

// KOL tier display labels — maps Supabase enum values → human-readable strings
// These appear on KolCard tier badges throughout the leaderboard and chat results.
const TIER_LABELS = {
  tier_1_national: 'Tier 1 · National',  // Top ~10% nationally recognized
  tier_2_regional: 'Tier 2 · Regional',  // Strong regional presence
  tier_3_local:    'Tier 3 · Local',     // Locally active, community setting
  rising_star:     'Rising Star ⚡',     // FFPS-flagged high-trajectory fellows/early faculty
  unclassified:    'Unclassified',        // Pending tier assignment
};

// KOL tier accent colors — matches tier_labels order
// rising_star (#EC4899 pink) is intentionally distinct to draw attention in leaderboard
const TIER_COLORS = {
  tier_1_national: C.indigo,
  tier_2_regional: C.teal,
  tier_3_local:    C.warn,
  rising_star:     '#EC4899',
  unclassified:    C.muted,
};


// ── 4. AI SYSTEM PROMPT ───────────────────────────────────────────────────────
//
// This is the system prompt sent to Claude (claude-sonnet-4-20250514) on every
// chat request. It defines Syncofy's AI persona and grounds the assistant in
// accurate product facts.
//
// KEY DESIGN DECISIONS:
//   - "Never name competitors" — avoids legal risk and keeps positioning clean.
//     All competitor references become "legacy CRMs" / "legacy platforms" etc.
//   - Word limit (120 words) — keeps responses punchy for conference-floor demos.
//     Prospects won't read a wall of text at a booth.
//   - CTA at end — "tell them to tap Get Started" ensures the AI is closing,
//     not just answering.
//   - Live DB rows are appended to the USER message (not this system prompt) so
//     the context updates per-query without rebuilding the system prompt.
//
// TO UPDATE: Edit this string. Changes take effect on the next message send.
// No deployment needed — this lives entirely in the client.
//
const AI_SYSTEM = `You are Syncofy's engagement intelligence assistant at Pan-Hematology 2026 in San Francisco. You help pharma Medical Affairs, Commercial Strategy, and physician contacts understand Syncofy vs. legacy KOL platforms (never name competitors — call them "legacy CRMs", "legacy intelligence platforms", "legacy data warehouses").

Key facts:
- 8,953 hematology-oncology providers, 48 fields each, live database
- Advisory boards: 65-88% cost reduction, 6-8 weeks → 1-2 weeks via STRIDE automation
- FFPS algorithm: predicts emerging KOLs before competitors, 87% accuracy, 19 parameters
- Pricing: KOL X Premium $12K/yr, SIGNAL $25K/yr, Syncofy Intelligence $75K/yr, Advisory Board single $15,500, 3-pack $42K/yr, Speaker Support $8,500/event, KOL Landscape $8,500 one-time, Enterprise $120K/yr
- Compliance: PhRMA Code, Anti-Kickback, Sunshine Act automated
- Founded by Jason Yonehiro, 20+ years pharma (ADC Therapeutics, GSK, AstraZeneca, Amgen, Celgene)
- Contact: info@syncofy.ai

Be crisp, direct, consultative. Under 120 words. Use real numbers. If ready to move forward, tell them to tap "Get Started".`;


// ── 5. DATA CONSTANTS ─────────────────────────────────────────────────────────

/**
 * SERVICES — Syncofy product catalog
 *
 * Each entry is keyed by a stable product ID used as the checkbox value in Step 1
 * of the sales flow. Price is in USD (integer). The `tag` field maps to a color
 * group in the services selection UI.
 *
 * TAG → COLOR MAPPING (in SalesFlow step 1):
 *   "Intelligence"   → muted gray background
 *   "Predictive AI"  → indigo (premium positioning)
 *   "Execution"      → teal (action-oriented)
 *   "All-In"         → amber (enterprise upsell)
 *
 * PRICING SOURCE: 2026 Syncofy Rate Card
 * FMV BENCHMARKS: Sullivan Cotter / AAMC 2026 — do NOT reference Incyte SOP rates
 *
 * TO ADD A NEW SERVICE: Add a new key here. It will automatically appear in the
 * Step 1 service selection list with no other changes required.
 */
const SERVICES = {
  kolx_premium:  { id:"kolx_premium",  name:"KOL X Premium",         tag:"Intelligence",  price:12000,  unit:"/year",     desc:"Full access to 500 heme-onc KOLs — custom filters, tier badges, engagement history, exportable shortlists." },
  signal:        { id:"signal",        name:"Syncofy SIGNAL",         tag:"Intelligence",  price:25000,  unit:"/year",     desc:"Weekly KOL intelligence briefs — publication alerts, trial activity, competitive payment data." },
  syncofy_intel: { id:"syncofy_intel", name:"Syncofy Intelligence",   tag:"Predictive AI", price:75000,  unit:"/year",     desc:"FFPS-powered predictive KOL identification. Rank next-gen KOLs before competitors." },
  ab_single:     { id:"ab_single",     name:"Advisory Board (Single)",tag:"Execution",     price:15500,  unit:"/event",    desc:"Full STRIDE workflow. FMV-verified. Sunshine Act-ready. AI-transcribed. 2 weeks start to finish." },
  ab_annual:     { id:"ab_annual",     name:"Advisory Board Program", tag:"Execution",     price:42000,  unit:"/3 events", desc:"Three fully-managed advisory boards. 35% savings vs. single-event pricing." },
  speaker:       { id:"speaker",       name:"Speaker Program Support",tag:"Execution",     price:8500,   unit:"/event",    desc:"KOL identification, FMV, compliance screening, contracting, Sunshine Act documentation." },
  kol_mapping:   { id:"kol_mapping",   name:"KOL Landscape Report",   tag:"Intelligence",  price:8500,   unit:"one-time",  desc:"Custom-built KOL landscape — top 50 ranked, tier mapping, competitive engagement history." },
  enterprise:    { id:"enterprise",    name:"Enterprise Suite",        tag:"All-In",        price:120000, unit:"/year",     desc:"Everything: Intelligence + SIGNAL + unlimited advisory automation + dedicated CSM + API access." },
};

/**
 * LEGAL — agreements shown in Step 2 of the sales flow
 *
 * required:true  → checkbox is mandatory; "Confirm & Lock In Deal" button
 *                  is disabled until all required docs are checked.
 * required:false → optional; toggled separately (DPA has its own toggle).
 *
 * The DPA (id:"dpa") does NOT appear in this list by default — it only renders
 * when the user activates the `dpa` toggle. This prevents GDPR/CCPA friction
 * for US-only pharma contacts who don't need it.
 *
 * IMPORTANT: These summaries are UI copy only — they are NOT legally binding
 * reproductions of the executed documents. Full PDFs are sent by Jason within
 * 24 hours of form submission. Replace summaries with final language before launch.
 *
 * TODO: Wire the legal acknowledgment state to a Supabase INSERT on Step 3
 * advance, storing: user email, IP, timestamp, document IDs checked, and
 * dpa_opted_in boolean. Table suggestion: engagement_leads
 */
const LEGAL = [
  {
    id:       "nda",
    name:     "Mutual Non-Disclosure Agreement",
    abbr:     "NDA",
    required: true,
    summary:  "Protects both parties' confidential information. California law. 2-year term.",
  },
  {
    id:       "coi",
    name:     "Conflict of Interest Declaration",
    abbr:     "COI",
    required: true,
    summary:  "Confirms no material conflict. Required for PhRMA Code compliance.",
  },
  {
    id:       "msa",
    name:     "Master Services Agreement",
    abbr:     "MSA",
    required: true,
    summary:  "Governs service scope, payment terms, IP ownership, liability cap (1× annual fees).",
  },
  {
    id:       "dpa",
    name:     "Data Processing Agreement",
    abbr:     "DPA",
    required: false,  // Only shown when dpa toggle is enabled
    summary:  "Required for GDPR/CCPA-subject organizations. 72hr breach notification.",
  },
];

/**
 * LEGACY — competitive comparison table rows
 *
 * Rendered in the HOME view and on the conference handout (HTML file).
 * "legacy" column describes incumbent platform behavior WITHOUT naming them.
 * "syncofy" column states the Syncofy differentiator with specific numbers.
 *
 * POSITIONING PRINCIPLE: Larvol = passive intelligence. Syncofy = execution +
 * prediction. Frame: "Larvol tells you who the KOLs are — Syncofy gets them
 * in the room, pays them compliantly, predicts the next ones."
 */
const LEGACY = [
  { cap:"KOL Identification",       legacy:"Manual lists, static annual databases",             syncofy:"AI-ranked, 8,953+ live profiles, FFPS predictive scoring" },
  { cap:"Advisory Board Execution", legacy:"6–8 week manual process, third-party vendors",       syncofy:"1–2 weeks, STRIDE automation, built-in compliance" },
  { cap:"FMV Calculation",          legacy:"Spreadsheet estimates, annual review cycles",         syncofy:"Real-time Sullivan Cotter benchmarks, auto-documented" },
  { cap:"Sunshine Act Reporting",   legacy:"Post-event manual reconciliation",                   syncofy:"Automated at point of engagement, audit-ready export" },
  { cap:"Emerging KOL Prediction",  legacy:"None — reactive identification only",                syncofy:"FFPS algorithm, 87% accuracy, 19 weighted parameters" },
  { cap:"Cost per Advisory Board",  legacy:"$75K–$150K with vendor + compliance overhead",       syncofy:"$15,500 fully managed, all-inclusive" },
];

/**
 * STRIPE_LINKS — payment link URLs by tier
 *
 * ⚠ CURRENTLY TEST LINKS — replace before go-live.
 *
 * Tier routing logic (in getStripeLink()):
 *   totalPrice >= $75,000  → enterprise link
 *   totalPrice >= $25,000  → growth link
 *   otherwise              → starter link
 *
 * To get real Payment Link URLs:
 *   1. Log into Stripe Dashboard → Products → Payment Links
 *   2. Create a link for each price point (or use a flexible "custom amount" link)
 *   3. Paste the buy.stripe.com/... URL for each tier here
 *
 * NOTE: Stripe Payment Links don't require a server. They're hosted by Stripe
 * and handle the checkout session, receipt, and webhook — ideal for solo founder.
 */
const STRIPE_LINKS = {
  starter:    "https://buy.stripe.com/test_starter",    // <$25K: KOL X Premium, Speaker, KOL Landscape
  growth:     "https://buy.stripe.com/test_growth",     // $25K–$74K: SIGNAL + advisory combos
  enterprise: "https://buy.stripe.com/test_enterprise", // $75K+: Intelligence, Enterprise Suite
};

// Quick-fire chat prompts shown below the chat input — drive demos without typing
const QUICK_PROMPTS = [
  "Top AML KOLs in San Francisco",
  "DLBCL advisory board slate",
  "How does FFPS work?",
  "Advisory board cost vs legacy?",
];

// Disease filter options in the leaderboard dropdown
// Matches the values stored in disease_focus jsonb arrays in mv_provider_intelligence
const DISEASE_FILTERS = [
  "All", "AML", "CLL", "DLBCL", "Multiple Myeloma",
  "Lymphoma", "MDS", "CAR-T", "Myelofibrosis",
];


// ── 6. SHARED UI COMPONENTS ───────────────────────────────────────────────────

/**
 * SIcon — Syncofy brand logomark
 *
 * Rounded square with indigo→teal gradient, dark lowercase "s".
 * Rendered in the sticky Header and anywhere the brand needs representation.
 * Must appear in all Syncofy engagement platform interfaces per brand guidelines.
 *
 * @param {number} size - Width/height in px (default 28)
 */
const SIcon = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="10" fill="url(#sg)" />
    <defs>
      <linearGradient id="sg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6366F1" />
        <stop offset="1" stopColor="#00C2A8" />
      </linearGradient>
    </defs>
    <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle"
      fill="#08091A" fontWeight="800" fontSize="22" fontFamily="'DM Sans',sans-serif">
      s
    </text>
  </svg>
);

/**
 * Tag — small inline label chip (disease area, service category, tier)
 *
 * @param {string} color - Text color (default C.muted)
 * @param {string} bg    - Background color (default rgba gray)
 */
const Tag = ({ children, color = C.muted, bg = "rgba(120,130,150,0.1)" }) => (
  <span style={{
    display:"inline-block", background:bg, color,
    fontSize:10, fontWeight:700, letterSpacing:"0.5px", textTransform:"uppercase",
    padding:"2px 8px", borderRadius:5,
  }}>
    {children}
  </span>
);

/**
 * Input — labeled form field with optional hint text
 *
 * Used throughout the sales flow (Step 0 profile capture).
 * Styled to match the Syncofy dark design system.
 */
const Input = ({ label, value, onChange, placeholder, type = "text", hint }) => (
  <div style={{ marginBottom:14 }}>
    {label && (
      <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:6 }}>
        {label}
      </div>
    )}
    <input
      value={value} onChange={onChange} placeholder={placeholder} type={type}
      style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"11px 14px", color:C.text, fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"'DM Sans',sans-serif" }}
    />
    {hint && <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{hint}</div>}
  </div>
);

/**
 * Btn — primary action button with three variants
 *
 * variant="primary"  → indigo→teal gradient (default, CTAs)
 * variant="success"  → solid green (Stripe payment, positive confirm)
 * variant="ghost"    → transparent with border (back buttons, secondary actions)
 *
 * disabled prop grays out and removes pointer cursor — used to gate step
 * advancement until required fields are complete.
 */
const Btn = ({ children, onClick, disabled, variant = "primary", style: s = {} }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background:
      variant === "primary" ? `linear-gradient(135deg,${C.indigo},${C.teal})` :
      variant === "success" ? C.success : "transparent",
    color:   variant === "ghost" ? C.muted : "#fff",
    border:  variant === "ghost" ? `1px solid ${C.border}` : "none",
    borderRadius:12, padding:"13px 24px", fontSize:15, fontWeight:800,
    cursor:  disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    fontFamily:"'DM Sans',sans-serif", transition:"opacity 0.15s", ...s,
  }}>
    {children}
  </button>
);

/**
 * KolCard — provider profile card used in both leaderboard and chat results
 *
 * FREEMIUM GATE: A locked "Premium" banner is always shown at the bottom of
 * every card, listing fields that require upgrade (email, CMS Open Payments,
 * full trial history, engagement timing). This drives conversion without
 * removing value — users see enough to confirm the KOL is real and relevant,
 * but need to pay for actionable contact/engagement data.
 *
 * KOL SCORE: Displayed in the top-left avatar. Scores >90 get the
 * indigo→teal gradient background to signal top-tier status visually.
 * Scores come from the kol_score column in mv_provider_intelligence,
 * calculated by the KOL Prediction Algorithm v3 (19 parameters, mentor
 * lineage weighted heaviest at 10).
 *
 * RISING STAR TREATMENT: rising_star tier gets a pink border and ⚡ FFPS badge
 * to draw attention — these are the FFPS-predicted next-gen KOLs that
 * differentiate Syncofy from competitors who can't predict emerging influence.
 *
 * @param {Object}   p        - Provider row from mv_provider_intelligence
 * @param {Function} onClick  - Optional click handler (navigates to Get Started)
 */
const KolCard = ({ p, onClick }) => {
  const col = TIER_COLORS[p.kol_tier] || C.muted;
  const isRising = p.kol_tier === 'rising_star';

  return (
    <div
      onClick={() => onClick && onClick(p)}
      style={{
        background: isRising ? 'rgba(236,72,153,0.04)' : C.card,
        border:     `1px solid ${isRising ? 'rgba(236,72,153,0.3)' : C.border}`,
        borderRadius:14, padding:"16px 18px", marginBottom:10,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ display:"flex", alignItems:"flex-start", gap:14 }}>
        {/* KOL Score avatar — gradient fill for scores >90 */}
        <div style={{
          width:34, height:34, borderRadius:9, flexShrink:0,
          background: p.kol_score > 90
            ? `linear-gradient(135deg,${C.indigo},${C.teal})`
            : C.surface,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:13, fontWeight:900,
          color: p.kol_score > 90 ? "#fff" : C.muted,
        }}>
          {p.kol_score || '—'}
        </div>

        {/* Name, tier badge, institution, disease tags */}
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ fontSize:15, fontWeight:700, color:C.text }}>
              {p.first_name} {p.last_name}{p.credentials ? `, ${p.credentials}` : ''}
            </span>
            <Tag color={col} bg={col + '18'}>{TIER_LABELS[p.kol_tier] || '—'}</Tag>
            {isRising && <span style={{ fontSize:11, fontWeight:700, color:'#EC4899' }}>⚡ FFPS</span>}
          </div>
          <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>
            {p.institution_name}{p.city ? ` · ${p.city}, ${p.state}` : ''}
          </div>
          {/* Disease tags — show first 3 to avoid overflow */}
          <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:5 }}>
            {(p.disease_focus || []).slice(0, 3).map(d => (
              <span key={d} style={{
                background:'rgba(99,102,241,0.1)', color:'#818CF8',
                border:'1px solid rgba(99,102,241,0.2)',
                borderRadius:4, padding:'1px 6px', fontSize:10,
              }}>{d}</span>
            ))}
          </div>
        </div>

        {/* Stats (publications, h-index, trials) — JetBrains Mono for data readability */}
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ display:"flex", gap:14 }}>
            {[['Pubs', p.publications_count], ['H', p.h_index], ['Trials', p.clinical_trials_count]].map(([l, v]) => (
              <div key={l} style={{ textAlign:"center" }}>
                <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:700, color:C.text }}>
                  {v ?? '—'}
                </div>
                <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase" }}>{l}</div>
              </div>
            ))}
          </div>
          {/* Conference presence indicators */}
          {(p.ash_presenter || p.asco_presenter) && (
            <div style={{ fontSize:10, color:C.teal + '80', marginTop:4 }}>
              {p.ash_presenter && '● ASH '}{p.asco_presenter && '● ASCO'}
            </div>
          )}
        </div>
      </div>

      {/* Freemium lock banner — always shown, drives upgrade intent */}
      <div style={{ marginTop:10, background:C.indigoDim, border:`1px solid rgba(99,102,241,0.2)`, borderRadius:8, padding:"8px 12px" }}>
        <span style={{ fontSize:11, color:C.indigo, fontWeight:700 }}>🔒 Premium: </span>
        <span style={{ fontSize:11, color:C.muted }}>
          Email · CMS Open Payments · Full trial history · Engagement timing — unlock with KOL X Premium
        </span>
      </div>
    </div>
  );
};


// ── 7. MAIN APP COMPONENT ─────────────────────────────────────────────────────

/**
 * SyncofyApp — root component, manages all global state and view routing
 *
 * VIEW ROUTING:
 *   "home"        → Marketing overview + AI chat (default landing)
 *   "leaderboard" → Live KOL X database browser with filters
 *   "sales"       → 4-step onboarding flow (salesStep 0–3)
 *
 * SALES FLOW STEPS:
 *   Step 0 (no userType): User type selection — pharma vs physician
 *   Step 0 (userType set): Profile capture + NPI verification (if physician)
 *   Step 1: Service selection with pricing
 *   Step 2: Legal acknowledgments (NDA, COI, MSA, optional DPA)
 *   Step 3: Confirmation + Stripe payment option
 *
 *   PHYSICIAN SHORTCUT: physicians skip steps 1–2 (no service selection,
 *   no legal signing) and jump directly to Step 3 confirmation after profile.
 *   They're registering as KOLs, not buying services.
 *
 * STATE ARCHITECTURE:
 *   - All state is local (useState) — no Redux, no Context needed at this scale
 *   - DB results (kols, chatKols) are ephemeral — re-fetched on filter change
 *   - Legal state (legal{}) is an object keyed by document id: {nda:bool, coi:bool, msa:bool}
 *   - ts (timestamp) is captured at component mount for legal acknowledgment records
 */
export default function SyncofyApp() {
  // ── Navigation
  const [view,      setView]      = useState("home");        // "home" | "leaderboard" | "sales"
  const [userType,  setUserType]  = useState(null);          // null | "pharma" | "physician"
  const [salesStep, setSalesStep] = useState(0);             // 0 | 1 | 2 | 3

  // ── Database / Leaderboard
  const [dbStatus,      setDbStatus]      = useState('checking'); // "checking" | "connected" | "error"
  const [dbCount,       setDbCount]       = useState('8,953');    // Live count from content-range header
  const [kols,          setKols]          = useState([]);         // Current page of provider rows
  const [kolLoading,    setKolLoading]    = useState(false);
  const [filterDisease, setFilterDisease] = useState('');         // PostgREST disease_focus filter
  const [filterTier,    setFilterTier]    = useState('');         // PostgREST kol_tier filter
  const [filterInst,    setFilterInst]    = useState('');         // PostgREST institution_name filter
  const [kolPage,       setKolPage]       = useState(0);          // Pagination page index (0-based)

  // ── User profile capture (Steps 0–1)
  const [individual,   setIndividual]   = useState({
    firstName:'', lastName:'', email:'',
    npi:'',          // 10-digit NPI — triggers CMS lookup when length===10
    credential:'',   // MD, DO, PhD, RN, PA-C, etc.
    specialty:'',    // Disease focus / therapeutic area
    institution:'',  // Auto-populated from NPI lookup
    role:'',         // Pharma role (Medical Affairs Director, MSL, etc.)
    linkedIn:'',     // Optional — for profile enrichment
  });
  const [npiVerified, setNpiVerified] = useState(null);  // null | "loading" | "verified" | "not_found"
  const [npiData,     setNpiData]     = useState(null);  // Parsed CMS NPI Registry response

  // ── Company info (pharma flow only)
  const [company, setCompany] = useState({ name:'', indication:'' });

  // ── Service selection (Step 1)
  const [selectedServices, setSelectedServices] = useState([]);  // Array of SERVICES keys

  // ── Legal acknowledgments (Step 2)
  const [legal, setLegal] = useState({});  // { nda: bool, coi: bool, msa: bool }
  const [dpa,   setDpa]   = useState(false); // Separate toggle for optional DPA

  // ── AI Chat (Home view)
  const [msgs,      setMsgs]      = useState([{
    role:    'assistant',
    content: "I'm Syncofy's AI with live access to **8,953 hematology-oncology providers**. Ask me about KOL intelligence, advisory boards, pricing, or search any physician by name.",
  }]);
  const [chatInput, setChatInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [chatKols,  setChatKols]  = useState([]); // Live DB rows injected into AI context + displayed below response

  // Auto-scroll chat to latest message
  const chatEnd = useRef(null);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior:'smooth' }); }, [msgs]);

  // Timestamp captured at mount — used in legal acknowledgment record on Step 3
  const [ts] = useState(new Date().toLocaleString());


  // ── DB HEALTH CHECK ────────────────────────────────────────────────────────
  //
  // Uses a HEAD request with Prefer: count=exact to get the live row count
  // from mv_provider_intelligence without fetching any data.
  // The count is returned in the content-range header as: 0-0/8953
  //
  // WHY ON MOUNT: The DB status indicator in the header needs to show
  // "connected" or "error" immediately when the app loads. A failed check
  // means RLS is blocking the anon key — check Supabase dashboard policies.
  //
  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/mv_provider_intelligence?select=id&is_active=eq.true`, {
      method: 'HEAD',
      headers: {
        apikey:        SUPABASE_ANON,
        Authorization: `Bearer ${SUPABASE_ANON}`,
        Prefer:        'count=exact',
      }
    })
    .then(r => {
      const cr = r.headers.get('content-range'); // e.g. "0-0/8953"
      const n  = cr?.split('/')[1];
      setDbCount(n && n !== '*' ? parseInt(n).toLocaleString() : '8,953');
      setDbStatus('connected');
    })
    .catch(() => setDbStatus('error'));
  }, []);


  // ── LEADERBOARD DATA FETCH ─────────────────────────────────────────────────
  //
  // Wrapped in useCallback so the function reference is stable and can be used
  // as both the useEffect dependency and the manual "Search" button handler.
  //
  // Fires when: view switches to "leaderboard", any filter changes, page changes.
  //
  const loadKols = useCallback(async () => {
    setKolLoading(true);
    try {
      const data = await sbQuery(buildKolQuery({
        disease:     filterDisease || null,
        tier:        filterTier    || null,
        institution: filterInst    || null,
        limit:  20,
        offset: kolPage * 20,
      }));
      setKols(data);
    } catch (e) {
      console.error('KOL load error:', e);
    } finally {
      setKolLoading(false);
    }
  }, [filterDisease, filterTier, filterInst, kolPage]);

  useEffect(() => {
    if (view === 'leaderboard') loadKols();
  }, [view, filterDisease, filterTier, filterInst, kolPage]);


  // ── NPI REGISTRY LOOKUP ────────────────────────────────────────────────────
  //
  // Hits the public CMS NPI Registry API (no auth required).
  // On success, auto-populates first_name, last_name, credential, specialty,
  // and institution from the registry response.
  //
  // API ENDPOINT: https://npiregistry.cms.hhs.gov/api/?number=XXXXXXXXXX&version=2.1
  //
  // FIELD MAPPING:
  //   basic.first_name       → individual.firstName
  //   basic.last_name        → individual.lastName
  //   basic.credential       → individual.credential (e.g. "MD")
  //   taxonomies[primary].desc → individual.specialty
  //   addresses[LOCATION].organization_name → individual.institution
  //
  // IMPORTANT: NPI data is public and doesn't constitute PII collection on our
  // end — it's data the physician registered with CMS. The Privacy Policy
  // discloses this lookup (see Syncofy_Regulatory_Positioning_Framework.docx).
  //
  const lookupNPI = async (npiNum) => {
    if (npiNum.length !== 10 || isNaN(npiNum)) return;
    setNpiVerified('loading');
    setNpiData(null);
    try {
      const res  = await fetch(`https://npiregistry.cms.hhs.gov/api/?number=${npiNum}&version=2.1`);
      const data = await res.json();
      if (data.result_count > 0) {
        const r    = data.results[0];
        const basic= r.basic || {};
        const tax  = r.taxonomies?.find(t => t.primary) || r.taxonomies?.[0] || {};
        const addr = r.addresses?.find(a => a.address_purpose === 'LOCATION') || r.addresses?.[0] || {};
        const verified = {
          name:        `${basic.first_name || ''} ${basic.last_name || ''}`.trim(),
          credential:  basic.credential || '',
          specialty:   tax.desc || '',
          institution: addr.organization_name || addr.address_1 || '',
          city:        addr.city  || '',
          state:       addr.state || '',
          npi:         npiNum,
        };
        setNpiData(verified);
        // Auto-populate form fields from registry data
        setIndividual(p => ({
          ...p,
          firstName:   basic.first_name       || p.firstName,
          lastName:    basic.last_name        || p.lastName,
          credential:  basic.credential       || p.credential,
          specialty:   tax.desc               || p.specialty,
          institution: addr.organization_name || p.institution,
        }));
        setNpiVerified('verified');
      } else {
        setNpiVerified('not_found');
      }
    } catch {
      setNpiVerified('not_found');
    }
  };


  // ── AI CHAT HANDLER ────────────────────────────────────────────────────────
  //
  // FLOW:
  //   1. Append user message to msgs (immediate UI update)
  //   2. Run detectIntent() to extract structured filters
  //   3. Query Supabase for matching KOL rows (RAG retrieval step)
  //   4. Append DB rows as context to the Claude API request
  //   5. POST to CLAUDE_PROXY (Supabase Edge Function)
  //   6. Append AI response to msgs
  //   7. Display chatKols below the AI response
  //
  // RAG CONTEXT FORMAT:
  //   The live DB rows are appended to the USER message text (not system prompt)
  //   as a plain-text table: "Name | Institution | Tier | Score | Pubs | H | Trials | Focus"
  //   This keeps the system prompt static and the per-query context dynamic.
  //
  // ERROR HANDLING:
  //   On any fetch failure, a graceful fallback message with info@syncofy.ai
  //   is shown — keeps the demo presentable even if the proxy is temporarily down.
  //
  // @param {string} [overrideText] - Optional text to send instead of chatInput
  //                                  (used by quick-prompt buttons)
  //
  const sendMsg = async (overrideText) => {
    const txt = (overrideText || chatInput).trim();
    if (!txt || aiLoading) return;

    setChatInput('');
    setMsgs(p => [...p, { role:'user', content:txt }]);
    setAiLoading(true);
    setChatKols([]);

    try {
      // Step 1: Intent detection + DB retrieval
      const intent = detectIntent(txt);
      const rows   = await sbQuery(buildKolQuery({
        name:        intent.name,
        tier:        intent.tier,
        disease:     intent.disease,
        institution: intent.institution,
        limit: 5,  // Top 5 is enough for AI context — full results in leaderboard
      }));
      if (rows.length > 0) setChatKols(rows);

      // Step 2: Build DB context string to inject into Claude request
      const ctx = rows.length > 0
        ? `\n\nLive DB results:\n${rows.map(p =>
            `- ${p.first_name} ${p.last_name}${p.credentials ? `, ${p.credentials}` : ''} | ${p.institution_name} | ${TIER_LABELS[p.kol_tier]} | Score:${p.kol_score} | Pubs:${p.publications_count} | H:${p.h_index} | Trials:${p.clinical_trials_count} | Focus:${(p.disease_focus||[]).slice(0,3).join(', ')}`
          ).join('\n')}`
        : '';

      // Step 3: POST to claude-proxy Edge Function
      // The proxy strips the apikey header and forwards to Anthropic with the
      // server-side ANTHROPIC_API_KEY env var. Full conversation history is
      // sent so Claude has context for follow-up questions.
      const res = await fetch(CLAUDE_PROXY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey:        SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system:     AI_SYSTEM,
          messages:   [...msgs, { role:'user', content: txt + ctx }]
            .map(m => ({ role: m.role, content: m.content })),
        }),
      });

      const d = await res.json();
      setMsgs(p => [...p, {
        role:    'assistant',
        content: d.content?.[0]?.text || 'Ask Jason directly — info@syncofy.ai',
      }]);
    } catch {
      setMsgs(p => [...p, {
        role:    'assistant',
        content: 'Connection issue. Reach Jason at info@syncofy.ai',
      }]);
    }
    setAiLoading(false);
  };


  // ── DERIVED STATE ──────────────────────────────────────────────────────────

  // Sum of all selected service prices — displayed in Step 1 investment summary
  // and Step 3 confirmation, and used to route to the correct Stripe link.
  const totalPrice = selectedServices.reduce((s, id) => s + (SERVICES[id]?.price || 0), 0);

  // Gate for Step 2 → Step 3: all required docs + any optional (DPA) ones must be checked
  const allLegalSigned = LEGAL
    .filter(d => d.required || (d.id === 'dpa' && dpa))
    .every(d => legal[d.id]);

  // Gate for Step 0 → Step 1: minimum profile fields required before continuing
  const profileOk = individual.firstName && individual.lastName && individual.email;

  // Stripe link tier routing — see STRIPE_LINKS comment above
  const getStripeLink = () =>
    totalPrice >= 75000 ? STRIPE_LINKS.enterprise :
    totalPrice >= 25000 ? STRIPE_LINKS.growth      :
    STRIPE_LINKS.starter;


  // ── SHARED LAYOUT COMPONENTS (defined inline for access to state) ──────────

  /**
   * Header — sticky top nav with logo, view switcher, and DB status indicator
   *
   * DB STATUS INDICATOR (top-right):
   *   Green dot + "N providers live" → Supabase connected, real-time count shown
   *   Red dot + "DB Error"           → RLS blocking anon or network issue
   *   Gray dot + "Connecting…"       → Health check in progress
   */
  const Header = () => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 24px", borderBottom:`1px solid ${C.border}`, background:C.surface, position:"sticky", top:0, zIndex:100 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer" }} onClick={() => setView("home")}>
        <SIcon size={28} />
        <span style={{ fontWeight:800, fontSize:17, color:C.text, letterSpacing:"-0.5px", fontFamily:"'DM Sans',sans-serif" }}>Syncofy</span>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        {[["home","Overview"], ["leaderboard","KOL X"], ["sales","Get Started"]].map(([v, l]) => (
          <button key={v}
            onClick={() => { setView(v); if (v === 'sales') { setSalesStep(0); setUserType(null); } }}
            style={{ background:view===v?C.indigoDim:"transparent", border:`1px solid ${view===v?C.indigo:C.border}`, color:view===v?C.indigo:C.muted, borderRadius:8, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:dbStatus==='connected'?C.teal:dbStatus==='error'?C.danger:C.muted }}>
        <div style={{ width:6, height:6, borderRadius:'50%', background:dbStatus==='connected'?C.teal:dbStatus==='error'?C.danger:C.muted }} />
        {dbStatus==='connected' ? `${dbCount} providers live` : dbStatus==='error' ? 'DB Error' : 'Connecting…'}
      </div>
    </div>
  );

  /**
   * Progress — animated step progress bar for the sales flow
   * Spans the full width below the Header during the sales flow.
   *
   * @param {number} step  - Current step (1-indexed for display)
   * @param {number} total - Total steps (4 for full pharma flow)
   */
  const Progress = ({ step, total }) => (
    <div style={{ height:3, background:C.border }}>
      <div style={{ height:"100%", width:`${(step / total) * 100}%`, background:`linear-gradient(90deg,${C.indigo},${C.teal})`, transition:"width 0.4s ease" }} />
    </div>
  );

  /** wrap — adds global styles + Header to any view */
  const wrap = (content) => (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-thumb { background:rgba(99,102,241,0.4); border-radius:2px; }
        select option { background:#131929; }
      `}</style>
      <Header />
      {content}
    </div>
  );


  // ══════════════════════════════════════════════════════════════════════════
  // 8. HOME VIEW
  // ──────────────────────────────────────────────────────────────────────────
  // Sections:
  //   A. Hero — headline, CTAs, event badge
  //   B. Stats grid — 4 key metrics
  //   C. Legacy comparison table — 6-row capability breakdown
  //   D. AI Chat — live DB + Claude, quick prompts, chatKols display
  //   E. Final CTA banner
  // ══════════════════════════════════════════════════════════════════════════
  if (view === 'home') return wrap(
    <div style={{ maxWidth:760, margin:"0 auto", padding:"50px 24px 80px" }}>

      {/* ── A. HERO ── */}
      <div style={{ textAlign:"center", marginBottom:56 }}>
        <div style={{ display:"inline-block", background:C.indigoDim, border:`1px solid rgba(99,102,241,0.35)`, color:C.indigo, borderRadius:20, padding:"4px 14px", fontSize:11, fontWeight:700, letterSpacing:"1.5px", textTransform:"uppercase", marginBottom:20 }}>
          Pan-Hematology 2026 · San Francisco
        </div>
        {/* Gradient headline — indigo to teal via CSS gradient text clip */}
        <h1 style={{ fontSize:40, fontWeight:900, letterSpacing:"-1.5px", lineHeight:1.1, marginBottom:18, background:`linear-gradient(135deg,${C.text} 40%,${C.teal})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
          Legacy KOL Platforms Monitor.<br />Syncofy Executes.
        </h1>
        <p style={{ fontSize:16, color:C.muted, lineHeight:1.7, maxWidth:520, margin:"0 auto 36px" }}>
          Legacy CRMs track activity. Legacy intelligence platforms sell you static lists. Syncofy identifies, engages, pays compliantly, and predicts who's next.
        </p>
        <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
          <Btn onClick={() => setView("leaderboard")}>Explore KOL X →</Btn>
          <Btn onClick={() => { setView("sales"); setSalesStep(0); setUserType(null); }} variant="ghost">Get Started</Btn>
        </div>
      </div>

      {/* ── B. STATS GRID ── */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:52 }}>
        {[["8,953+","H/O Providers"],["65–88%","Cost Reduction"],["1–2 wks","Advisory Timeline"],["87%","FFPS Accuracy"]].map(([v, l]) => (
          <div key={v} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"18px 14px", textAlign:"center" }}>
            <div style={{ fontSize:24, fontWeight:900, color:C.teal, letterSpacing:"-1px" }}>{v}</div>
            <div style={{ fontSize:11, color:C.muted, marginTop:5, lineHeight:1.4 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* ── C. LEGACY COMPARISON TABLE ── */}
      <div style={{ marginBottom:52 }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:12 }}>Why Syncofy</div>
        <h2 style={{ fontSize:24, fontWeight:800, letterSpacing:"-0.5px", marginBottom:20 }}>Built for what legacy platforms can't do.</h2>
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden" }}>
          {/* Table header */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", background:C.surface, padding:"10px 20px", borderBottom:`1px solid ${C.border}` }}>
            {["Capability","Legacy Platforms","Syncofy"].map((h, i) => (
              <div key={h} style={{ fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"1px", color:i===1?C.danger:i===2?C.teal:C.muted }}>{h}</div>
            ))}
          </div>
          {/* Table rows */}
          {LEGACY.map((r, i) => (
            <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", padding:"13px 20px", borderBottom:i < LEGACY.length-1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontSize:12, fontWeight:600, color:C.text }}>{r.cap}</div>
              <div style={{ fontSize:11, color:"rgba(239,68,68,0.8)", lineHeight:1.5, paddingRight:12 }}>{r.legacy}</div>
              <div style={{ fontSize:11, color:C.teal, lineHeight:1.5 }}>{r.syncofy}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── D. AI CHAT ── */}
      <div style={{ marginBottom:52 }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.indigo, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Live AI · {dbCount} Providers</div>
        <h2 style={{ fontSize:24, fontWeight:800, letterSpacing:"-0.5px", marginBottom:20 }}>Ask anything.</h2>
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden" }}>
          {/* Message thread */}
          <div style={{ height:280, overflowY:"auto", padding:"18px" }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start", marginBottom:12 }}>
                {m.role === "assistant" && (
                  <div style={{ width:26, height:26, borderRadius:7, background:`linear-gradient(135deg,${C.indigo},${C.teal})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:C.bg, marginRight:9, flexShrink:0, marginTop:2 }}>s</div>
                )}
                <div
                  style={{ maxWidth:"76%", background:m.role==="user"?C.indigoDim:C.surface, border:`1px solid ${m.role==="user"?"rgba(99,102,241,0.3)":C.border}`, borderRadius:m.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px", padding:"9px 13px", fontSize:13, color:m.role==="user"?C.indigo:C.text, lineHeight:1.6 }}
                  // Render **bold** markdown from AI responses inline
                  dangerouslySetInnerHTML={{ __html: m.content.replace(/\*\*(.*?)\*\*/g,'<strong style="color:#A5B4FC">$1</strong>').replace(/\n/g,'<br/>') }}
                />
              </div>
            ))}
            {/* Typing indicator */}
            {aiLoading && (
              <div style={{ display:"flex", gap:9, alignItems:"center" }}>
                <div style={{ width:26, height:26, borderRadius:7, background:`linear-gradient(135deg,${C.indigo},${C.teal})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:C.bg }}>s</div>
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:"14px 14px 14px 4px", padding:"9px 14px", fontSize:13, color:C.muted }}>Thinking…</div>
              </div>
            )}
            <div ref={chatEnd} />
          </div>

          {/* Live KOL results below AI response (RAG results display) */}
          {chatKols.length > 0 && (
            <div style={{ borderTop:`1px solid ${C.border}`, padding:"12px 18px" }}>
              <div style={{ fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>Live Results</div>
              {chatKols.slice(0, 3).map(p => <KolCard key={p.id} p={p} onClick={() => setView('sales')} />)}
            </div>
          )}

          {/* Input row */}
          <div style={{ borderTop:`1px solid ${C.border}`, display:"flex", gap:8, padding:"10px 14px" }}>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMsg()}
              placeholder="Ask about KOLs, advisory boards, pricing, FFPS…"
              style={{ flex:1, background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, padding:"9px 13px", color:C.text, fontSize:13, outline:"none", fontFamily:"'DM Sans',sans-serif" }}
            />
            <button onClick={() => sendMsg()} disabled={aiLoading || !chatInput.trim()}
              style={{ background:`linear-gradient(135deg,${C.indigo},${C.teal})`, color:"#fff", border:"none", borderRadius:9, padding:"9px 16px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:aiLoading||!chatInput.trim()?0.5:1, fontFamily:"'DM Sans',sans-serif" }}>
              Send
            </button>
          </div>

          {/* Quick-fire prompt buttons */}
          <div style={{ borderTop:`1px solid ${C.border}`, padding:"8px 14px", display:"flex", gap:8, flexWrap:"wrap" }}>
            {QUICK_PROMPTS.map(q => (
              <button key={q} onClick={() => sendMsg(q)}
                style={{ background:C.indigoDim, border:`1px solid rgba(99,102,241,0.25)`, color:C.indigo, borderRadius:20, padding:"3px 11px", fontSize:11, cursor:"pointer", fontWeight:600, fontFamily:"'DM Sans',sans-serif" }}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── E. FINAL CTA BANNER ── */}
      <div style={{ background:`linear-gradient(135deg,rgba(99,102,241,0.1),rgba(0,194,168,0.08))`, border:`1px solid rgba(99,102,241,0.25)`, borderRadius:20, padding:"36px 32px", textAlign:"center" }}>
        <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px", marginBottom:10 }}>See your KOLs ranked live. Then let's close.</h2>
        <p style={{ fontSize:14, color:C.muted, marginBottom:24 }}>8,953 hematology-oncology providers. Updated continuously.</p>
        <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
          <Btn onClick={() => setView("leaderboard")}>Open KOL X →</Btn>
          <Btn onClick={() => { setView("sales"); setSalesStep(0); setUserType(null); }} variant="ghost">Get Started</Btn>
        </div>
      </div>
    </div>
  );


  // ══════════════════════════════════════════════════════════════════════════
  // 9. LEADERBOARD VIEW
  // ──────────────────────────────────────────────────────────────────────────
  // Live-queried KOL browser with disease / tier / institution filters.
  // Pagination: 20 per page, prev/next buttons.
  // Every KolCard shows a freemium lock banner → drives Get Started conversions.
  // Empty state and loading state handled.
  // ══════════════════════════════════════════════════════════════════════════
  if (view === 'leaderboard') return wrap(
    <div style={{ maxWidth:800, margin:"0 auto", padding:"36px 24px 80px" }}>
      <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:8 }}>KOL X · Live Database</div>
      <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-1px", marginBottom:6 }}>Hematology-Oncology Intelligence</h1>
      <p style={{ fontSize:13, color:C.muted, marginBottom:24 }}>{dbCount} providers profiled nationally · Ranked by Syncofy Engagement Score</p>

      {/* Filter bar */}
      <div style={{ display:"flex", gap:8, marginBottom:20, flexWrap:"wrap" }}>
        {/* Disease dropdown */}
        <select value={filterDisease} onChange={e => { setFilterDisease(e.target.value === "All" ? '' : e.target.value); setKolPage(0); }}
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:filterDisease?C.text:C.muted, fontSize:12, outline:"none", cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
          {DISEASE_FILTERS.map(d => <option key={d} value={d}>{d === "All" ? "All Disease Areas" : d}</option>)}
        </select>

        {/* Tier dropdown */}
        <select value={filterTier} onChange={e => { setFilterTier(e.target.value); setKolPage(0); }}
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:filterTier?C.text:C.muted, fontSize:12, outline:"none", cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
          <option value="">All Tiers</option>
          <option value="tier_1_national">Tier 1 — National</option>
          <option value="tier_2_regional">Tier 2 — Regional</option>
          <option value="tier_3_local">Tier 3 — Local</option>
          <option value="rising_star">Rising Stars</option>
        </select>

        {/* Institution text input — submit on Enter or Search button */}
        <input value={filterInst} onChange={e => setFilterInst(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadKols()}
          placeholder="Institution…"
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:C.text, fontSize:12, outline:"none", fontFamily:"'DM Sans',sans-serif", width:160 }} />
        <button onClick={loadKols}
          style={{ background:`linear-gradient(135deg,${C.indigo},${C.teal})`, color:"#fff", border:"none", borderRadius:8, padding:"7px 16px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
          Search
        </button>
      </div>

      {/* Results */}
      {kolLoading
        ? <div style={{ color:C.muted, textAlign:"center", padding:60 }}>Loading live providers…</div>
        : <>
          {kols.map(p => <KolCard key={p.id} p={p} onClick={() => { setView('sales'); setSalesStep(0); setUserType(null); }} />)}
          {kols.length === 0 && <div style={{ color:C.muted, textAlign:"center", padding:40 }}>No results — try different filters.</div>}
          {/* Pagination — prev/next only shown when applicable */}
          <div style={{ display:"flex", gap:10, justifyContent:"center", marginTop:16 }}>
            {kolPage > 0      && <Btn onClick={() => setKolPage(p => p-1)} variant="ghost" style={{ padding:"8px 18px", fontSize:13 }}>← Prev</Btn>}
            {kols.length === 20 && <Btn onClick={() => setKolPage(p => p+1)} style={{ padding:"8px 18px", fontSize:13 }}>Next →</Btn>}
          </div>
        </>
      }

      {/* Upgrade CTA */}
      <div style={{ background:C.card, border:`1px dashed ${C.border}`, borderRadius:14, padding:"22px", textAlign:"center", marginTop:16 }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>
          Full profiles unlock with KOL X Premium — email, CMS Open Payments, trial history, engagement timing
        </div>
        <Btn onClick={() => { setView("sales"); setSalesStep(0); setUserType(null); }}>Get Full Access →</Btn>
      </div>
    </div>
  );


  // ══════════════════════════════════════════════════════════════════════════
  // 10. SALES FLOW
  // ──────────────────────────────────────────────────────────────────────────
  // Step 0a: User type selection (pharma vs physician)
  // Step 0b: Profile capture + NPI verification
  // Step 1:  Service selection (pharma only)
  // Step 2:  Legal acknowledgments (pharma only)
  // Step 3:  Confirmation + Stripe CTA
  //
  // Progress bar sits between Header and content — updates on each step advance.
  // ══════════════════════════════════════════════════════════════════════════
  if (view === 'sales') return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}select option{background:#131929}`}</style>
      <Header />
      {/* Progress bar — salesStep is 0-indexed; Progress takes 1-indexed step */}
      <Progress step={salesStep + 1} total={4} />

      <div style={{ maxWidth:660, margin:"0 auto", padding:"36px 24px 100px" }}>

        {/* ── STEP 0a: User Type Selection ── */}
        {salesStep === 0 && !userType && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 1 of 4</div>
            <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Who are you joining us as?</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:32 }}>We'll tailor your experience and build your verified Syncofy profile.</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
              {[
                { type:"pharma",    icon:"💊", title:"Pharma / Biotech Professional", desc:"Medical Affairs, Commercial Strategy, BD, Clinical Operations, C-Suite" },
                { type:"physician", icon:"🩺", title:"Physician / Researcher",         desc:"Oncologist, Hematologist, Fellow, Academic Researcher, Clinical PI" },
              ].map(opt => (
                <div key={opt.type} onClick={() => setUserType(opt.type)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:"24px 20px", cursor:"pointer", textAlign:"center" }}>
                  <div style={{ fontSize:40, marginBottom:14 }}>{opt.icon}</div>
                  <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>{opt.title}</div>
                  <div style={{ fontSize:12, color:C.muted, lineHeight:1.5 }}>{opt.desc}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── STEP 0b: Profile Capture ── */}
        {salesStep === 0 && userType && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 1 of 4 — Your Profile</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>
              {userType === "physician" ? "Build your verified clinician profile." : "Tell us about yourself."}
            </h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:28 }}>
              {userType === "physician"
                ? "Enter your NPI to auto-verify from the CMS registry in real time."
                : "We'll personalize your recommendations and pre-fill agreements."}
            </p>

            {/* NPI verification block — physicians only */}
            {userType === "physician" && (
              <div style={{ background:"rgba(99,102,241,0.06)", border:`1px solid rgba(99,102,241,0.25)`, borderRadius:14, padding:"18px 20px", marginBottom:24 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.indigo, marginBottom:12 }}>🔍 NPI Registry Auto-Verify</div>
                <div style={{ display:"flex", gap:10 }}>
                  <input value={individual.npi} onChange={e => setIndividual(p => ({...p, npi:e.target.value}))} placeholder="10-digit NPI number"
                    style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:9, padding:"10px 13px", color:C.text, fontSize:14, outline:"none", fontFamily:"'DM Sans',sans-serif" }} />
                  <button onClick={() => lookupNPI(individual.npi)} disabled={individual.npi.length !== 10}
                    style={{ background:`linear-gradient(135deg,${C.indigo},${C.teal})`, color:"#fff", border:"none", borderRadius:9, padding:"10px 18px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:individual.npi.length===10?1:0.45, fontFamily:"'DM Sans',sans-serif" }}>
                    Verify
                  </button>
                </div>
                {npiVerified === "loading"    && <div style={{ fontSize:12, color:C.muted, marginTop:8 }}>Checking NPI Registry…</div>}
                {npiVerified === "not_found"  && <div style={{ fontSize:12, color:C.danger, marginTop:8 }}>NPI not found — fill in manually below.</div>}
                {npiVerified === "verified" && npiData && (
                  <div style={{ marginTop:10, background:"rgba(16,185,129,0.08)", border:`1px solid rgba(16,185,129,0.3)`, borderRadius:9, padding:"10px 14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:C.success, marginBottom:6 }}>✓ Verified via CMS NPI Registry</div>
                    <div style={{ fontSize:13, color:C.text }}><strong>{npiData.name}</strong>{npiData.credential ? `, ${npiData.credential}` : ""}</div>
                    <div style={{ fontSize:12, color:C.muted }}>{npiData.specialty}</div>
                    <div style={{ fontSize:12, color:C.muted }}>{npiData.institution}{npiData.city ? ` · ${npiData.city}, ${npiData.state}` : ""}</div>
                  </div>
                )}
                <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>
                  Public CMS data only. Enables Sunshine Act compliance tracking and KOL profile matching.
                </div>
              </div>
            )}

            {/* Core profile fields — 2-column grid */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <Input label="First Name"  value={individual.firstName}   onChange={e => setIndividual(p=>({...p,firstName:e.target.value}))}   placeholder="First" />
              <Input label="Last Name"   value={individual.lastName}    onChange={e => setIndividual(p=>({...p,lastName:e.target.value}))}    placeholder="Last" />
              <div style={{ gridColumn:"1/-1" }}>
                <Input label="Work Email" value={individual.email} onChange={e => setIndividual(p=>({...p,email:e.target.value}))} placeholder="you@company.com" type="email" />
              </div>
              <Input label="Credential"       value={individual.credential} onChange={e => setIndividual(p=>({...p,credential:e.target.value}))} placeholder="MD, DO, PhD…" />
              <Input label="Specialty / Focus" value={individual.specialty}  onChange={e => setIndividual(p=>({...p,specialty:e.target.value}))}  placeholder="e.g. CLL, AML, Lymphoma" />
              <div style={{ gridColumn:"1/-1" }}>
                <Input label="Institution" value={individual.institution} onChange={e => setIndividual(p=>({...p,institution:e.target.value}))} placeholder="Hospital, company, or academic center" />
              </div>
            </div>

            {/* Pharma-only additional fields */}
            {userType === "pharma" && (
              <>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:6 }}>Your Role</div>
                <select value={individual.role} onChange={e => setIndividual(p => ({...p, role:e.target.value}))}
                  style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"11px 14px", color:individual.role?C.text:C.muted, fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"'DM Sans',sans-serif", appearance:"none", marginBottom:14 }}>
                  <option value="">Select role…</option>
                  {["Medical Affairs Director","VP Medical Affairs","MSL / Field Medical","Commercial Strategy","Business Development","C-Suite / Founder","Clinical Operations","Market Access"].map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <Input label="Company"            value={company.name}       onChange={e => setCompany(p=>({...p,name:e.target.value}))}       placeholder="e.g. BeiGene, Iovance, Legend Biotech" />
                <Input label="Primary Indication" value={company.indication} onChange={e => setCompany(p=>({...p,indication:e.target.value}))} placeholder="e.g. CLL, DLBCL, Multiple Myeloma" />
              </>
            )}

            <Input label="LinkedIn (optional)" value={individual.linkedIn} onChange={e => setIndividual(p=>({...p,linkedIn:e.target.value}))}
              placeholder="linkedin.com/in/yourname"
              hint="Helps match your clinical and publication profile." />

            <div style={{ display:"flex", gap:10, marginTop:8 }}>
              <Btn onClick={() => setUserType(null)} variant="ghost">← Back</Btn>
              {/* Physicians skip service + legal steps — jump straight to confirmation */}
              <Btn onClick={() => setSalesStep(userType === "physician" ? 3 : 1)} disabled={!profileOk} style={{ flex:1 }}>
                {userType === "physician" ? "Register as KOL →" : "Continue →"}
              </Btn>
            </div>
          </>
        )}

        {/* ── STEP 1: Service Selection ── */}
        {salesStep === 1 && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 2 of 4 — Services</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Build your engagement stack.</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:24 }}>Select everything that applies to {company.name || "your organization"}.</p>

            {/* Bundle suggestion */}
            <div style={{ background:"rgba(245,158,11,0.06)", border:`1px solid rgba(245,158,11,0.3)`, borderRadius:14, padding:"16px 18px", marginBottom:20 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.warn, marginBottom:6 }}>💡 Most Popular: Launch Intelligence Pack</div>
              <div style={{ fontSize:13, color:C.muted, marginBottom:10 }}>
                KOL Landscape + SIGNAL + Advisory Board — <span style={{ color:C.warn, fontWeight:700 }}>$42,000</span>{" "}
                <span style={{ textDecoration:"line-through", opacity:0.6 }}>$49,500</span> · Save $7,500
              </div>
              <button onClick={() => setSelectedServices(["kol_mapping","signal","ab_single"])}
                style={{ background:"rgba(245,158,11,0.15)", border:`1px solid rgba(245,158,11,0.4)`, color:C.warn, borderRadius:8, padding:"5px 13px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>
                Select Bundle
              </button>
            </div>

            {/* Service checkboxes — rendered from SERVICES constant */}
            {Object.values(SERVICES).map(s => {
              const active = selectedServices.includes(s.id);
              // Tag → [background, text color] mapping for visual grouping
              const tagColors = {
                "Predictive AI":  [C.indigoDim, C.indigo],
                "Execution":      [C.tealDim,   C.teal],
                "All-In":         ["rgba(245,158,11,0.12)", C.warn],
                "Intelligence":   ["rgba(120,130,150,0.1)", C.muted],
              };
              const [tbg, tco] = tagColors[s.tag] || tagColors.Intelligence;

              return (
                <div key={s.id}
                  onClick={() => setSelectedServices(p => p.includes(s.id) ? p.filter(x => x !== s.id) : [...p, s.id])}
                  style={{ background:active?C.indigoDim:C.card, border:`1px solid ${active?C.indigo:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:10, cursor:"pointer", display:"flex", gap:13, alignItems:"flex-start" }}>
                  {/* Checkbox */}
                  <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${active?C.indigo:C.border}`, background:active?C.indigo:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                    {active && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
                  </div>
                  <div style={{ flex:1 }}>
                    <Tag bg={tbg} color={tco}>{s.tag}</Tag>
                    <div style={{ fontSize:15, fontWeight:700, marginTop:5, marginBottom:4 }}>{s.name}</div>
                    <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>{s.desc}</div>
                  </div>
                  {/* Price */}
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:19, fontWeight:900, color:C.teal }}>${s.price.toLocaleString()}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{s.unit}</div>
                  </div>
                </div>
              );
            })}

            {/* Investment summary — shows when any service is selected */}
            {selectedServices.length > 0 && (
              <div style={{ background:C.card, border:`1px solid ${C.teal}`, borderRadius:12, padding:"15px 18px", display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:4 }}>
                <div>
                  <div style={{ fontWeight:700 }}>Your Investment</div>
                  {/* Legacy comparison — estimated 3× multiplier vs traditional vendors */}
                  <div style={{ fontSize:12, color:C.success }}>vs. ~${(totalPrice * 3).toLocaleString()} legacy vendor equivalent</div>
                </div>
                <div style={{ fontSize:26, fontWeight:900, color:C.teal }}>${totalPrice.toLocaleString()}</div>
              </div>
            )}

            <div style={{ display:"flex", gap:10, marginTop:20 }}>
              <Btn onClick={() => setSalesStep(0)} variant="ghost">← Back</Btn>
              <Btn onClick={() => setSalesStep(2)} disabled={selectedServices.length === 0} style={{ flex:1 }}>Proceed to Agreements →</Btn>
            </div>
          </>
        )}

        {/* ── STEP 2: Legal Acknowledgments ── */}
        {salesStep === 2 && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 3 of 4 — Agreements</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Let's protect both of us.</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:28 }}>
              <strong style={{ color:C.text }}>{individual.firstName} {individual.lastName}</strong> confirms authority to bind{" "}
              <strong style={{ color:C.text }}>{company.name || "your organization"}</strong>. Countersigned copies sent to{" "}
              <strong style={{ color:C.text }}>{individual.email}</strong> within 24 hours.
            </p>

            {/* Required docs: NDA, COI, MSA. DPA only shown if dpa toggle is on. */}
            {LEGAL.filter(d => d.required || (d.id === 'dpa' && dpa)).map(d => {
              const checked = legal[d.id];
              return (
                <div key={d.id}
                  onClick={() => setLegal(p => ({...p, [d.id]: !p[d.id]}))}
                  style={{ display:"flex", gap:13, alignItems:"flex-start", background:checked?"rgba(16,185,129,0.06)":C.card, border:`1px solid ${checked?C.success:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:12, cursor:"pointer" }}>
                  <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${checked?C.success:C.border}`, background:checked?C.success:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                    {checked && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
                  </div>
                  <div>
                    <div style={{ fontWeight:700, marginBottom:4, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      {d.name}
                      <span style={{ fontSize:10, background:C.border, color:C.muted, padding:"1px 6px", borderRadius:4, fontWeight:600 }}>{d.abbr}</span>
                      {d.required && <span style={{ fontSize:10, color:C.danger, fontWeight:700 }}>REQUIRED</span>}
                    </div>
                    <div style={{ fontSize:13, color:C.muted, lineHeight:1.6 }}>{d.summary}</div>
                  </div>
                </div>
              );
            })}

            {/* DPA toggle — shown separately since it's optional and binary */}
            <div onClick={() => setDpa(p => !p)}
              style={{ display:"flex", gap:13, alignItems:"flex-start", background:C.card, border:`1px solid ${dpa?C.indigo:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:20, cursor:"pointer" }}>
              <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${dpa?C.indigo:C.border}`, background:dpa?C.indigo:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                {dpa && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
              </div>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Add DPA (GDPR / CCPA) <span style={{ fontSize:11, color:C.muted, fontWeight:400 }}>— Optional</span></div>
                <div style={{ fontSize:13, color:C.muted }}>Required if your organization is subject to GDPR or CCPA regulations.</div>
              </div>
            </div>

            {/* Legal disclaimer — no payment obligation until executed contract */}
            <div style={{ background:"rgba(245,158,11,0.06)", border:`1px solid rgba(245,158,11,0.25)`, borderRadius:10, padding:"12px 15px", marginBottom:20 }}>
              <div style={{ fontSize:11, color:C.warn, fontWeight:700, marginBottom:4 }}>⚠ No payment obligation created by this acknowledgment alone.</div>
              <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>Fully executed documents within 24 hours. Syncofy, LLC · Jason Yonehiro, CEO · info@syncofy.ai</div>
            </div>

            <div style={{ display:"flex", gap:10 }}>
              <Btn onClick={() => setSalesStep(1)} variant="ghost">← Back</Btn>
              {/* Gate: all required docs must be checked */}
              <Btn onClick={() => setSalesStep(3)} disabled={!allLegalSigned} style={{ flex:1 }}>✓ Confirm &amp; Lock In Deal</Btn>
            </div>
          </>
        )}

        {/* ── STEP 3: Confirmation ── */}
        {salesStep === 3 && (
          <div style={{ textAlign:"center", paddingTop:12 }}>
            <div style={{ fontSize:60, marginBottom:20 }}>{userType === "physician" ? "🏆" : "🎯"}</div>
            <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-1px", marginBottom:10 }}>
              {userType === "physician"
                ? `Welcome to KOL X, Dr. ${individual.lastName}.`
                : `You're in, ${individual.firstName}.`}
            </h1>
            <p style={{ fontSize:14, color:C.muted, maxWidth:440, margin:"0 auto 32px", lineHeight:1.7 }}>
              {userType === "physician"
                ? `Your verified profile has been captured. Syncofy will send your KOL X ranking and engagement opportunities to ${individual.email}.`
                : `Jason will send executed documents and platform access to ${individual.email} within 24 hours.`}
            </p>

            {/* Deal summary card */}
            <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:"22px 24px", textAlign:"left", marginBottom:16 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"1px", marginBottom:14 }}>
                {userType === "physician" ? "Verified Profile" : "Deal Summary"}
              </div>
              {[
                ["Name",      `${individual.firstName} ${individual.lastName}${individual.credential ? `, ${individual.credential}` : ""}`],
                ["Email",     individual.email],
                individual.npi         && ["NPI",         `${individual.npi} ${npiVerified==="verified" ? "✓ CMS Verified" : ""}`],
                individual.specialty   && ["Specialty",   individual.specialty],
                individual.institution && ["Institution", individual.institution],
                userType==="pharma" && company.name                 && ["Company",  company.name],
                userType==="pharma" && selectedServices.length > 0  && ["Services", selectedServices.map(id => SERVICES[id]?.name).join(", ")],
              ].filter(Boolean).map(([k, v]) => (
                <div key={k} style={{ display:"flex", gap:12, marginBottom:8, fontSize:13 }}>
                  <span style={{ color:C.muted, minWidth:90 }}>{k}</span>
                  <span style={{ color:C.text, fontWeight:600 }}>{v}</span>
                </div>
              ))}
              {/* Total investment row */}
              {userType === "pharma" && totalPrice > 0 && (
                <div style={{ borderTop:`1px solid ${C.border}`, marginTop:14, paddingTop:14, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontWeight:700 }}>Investment</span>
                  <span style={{ fontSize:26, fontWeight:900, color:C.teal }}>${totalPrice.toLocaleString()}</span>
                </div>
              )}
            </div>

            {/* Legal acknowledgment receipt */}
            {userType === "pharma" && Object.values(legal).some(Boolean) && (
              <div style={{ background:"rgba(16,185,129,0.06)", border:`1px solid rgba(16,185,129,0.3)`, borderRadius:12, padding:"13px 17px", textAlign:"left", marginBottom:16 }}>
                {/* ts = timestamp captured at component mount — anchors acknowledgment time */}
                <div style={{ fontSize:12, fontWeight:700, color:C.success, marginBottom:8 }}>✓ Legal Acknowledgments Captured · {ts}</div>
                {LEGAL.filter(d => legal[d.id]).map(d => (
                  <div key={d.id} style={{ fontSize:12, color:C.muted, marginBottom:3 }}>· {d.name} ({d.abbr})</div>
                ))}
              </div>
            )}

            {/* Stripe payment CTA — optional, immediate activation path */}
            {userType === "pharma" && totalPrice > 0 && (
              <div style={{ background:"rgba(99,102,241,0.06)", border:`1px solid rgba(99,102,241,0.25)`, borderRadius:14, padding:"20px", marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.indigo, marginBottom:8 }}>💳 Optional: Pay Now to Activate Immediately</div>
                <div style={{ fontSize:12, color:C.muted, marginBottom:16 }}>
                  Skip the invoice — activate your Syncofy account today. Secure checkout powered by Stripe.
                </div>
                {/* Opens Stripe Payment Link in new tab */}
                <Btn onClick={() => window.open(getStripeLink(), "_blank")} variant="success" style={{ width:"100%", padding:"13px" }}>
                  Pay ${totalPrice.toLocaleString()} via Stripe →
                </Btn>
                <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>
                  Or: Jason will send an invoice to {individual.email} within 24 hours.
                </div>
              </div>
            )}

            <div style={{ fontSize:13, color:C.muted }}>
              Questions? <strong style={{ color:C.text }}>info@syncofy.ai</strong> · Jason Yonehiro, CEO
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
