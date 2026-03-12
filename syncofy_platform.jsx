import { useState, useEffect, useRef, useCallback } from "react";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://vdweyrjafrlnvqkztlrz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_KA7Z6v1gPgXEqcDsjeoiyw_qf1GejsQ';
const CLAUDE_PROXY  = 'https://vdweyrjafrlnvqkztlrz.supabase.co/functions/v1/claude-proxy';

// ── SUPABASE ──────────────────────────────────────────────────────────────────
async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` }
  });
  if (!res.ok) throw new Error(`DB ${res.status}`);
  return res.json();
}

function buildKolQuery({ name, tier, disease, institution, limit = 20, offset = 0 }) {
  let q = `mv_provider_intelligence?select=id,npi,first_name,last_name,credentials,institution_name,city,state,kol_tier,kol_score,publications_count,h_index,clinical_trials_count,disease_focus,ash_presenter,asco_presenter&is_active=eq.true&order=kol_score.desc.nullslast&limit=${limit}&offset=${offset}`;
  if (name)        q += `&or=(first_name.ilike.*${name}*,last_name.ilike.*${name}*)`;
  if (tier)        q += `&kol_tier=eq.${tier}`;
  if (institution) q += `&institution_name=ilike.*${institution}*`;
  if (disease)     q += `&disease_focus=cs.{"${disease}"}`;
  return q;
}

function detectIntent(q) {
  const t = q.toLowerCase();
  const diseases = { 'AML':['aml','acute myeloid'], 'DLBCL':['dlbcl','diffuse large b'], 'Multiple Myeloma':['myeloma'], 'CLL':['cll','chronic lymphocytic'], 'Lymphoma':['lymphoma','nhl'], 'MDS':['mds','myelodysplastic'], 'CAR-T':['car-t','cart'], 'Myelofibrosis':['myelofibrosis'] };
  const insts = { 'MD Anderson':'md anderson','Memorial Sloan Kettering':'memorial sloan','Mayo Clinic':'mayo','Dana-Farber':'dana-farber','City of Hope':'city of hope','Stanford':'stanford','Fred Hutch':'fred hutch','UCSF':'ucsf' };
  let disease = null, institution = null, tier = null;
  for (const [k,v] of Object.entries(diseases)) if (v.some(x=>t.includes(x))) { disease=k; break; }
  for (const [k,v] of Object.entries(insts)) if (t.includes(v)) { institution=k; break; }
  if (t.includes('tier 1')||t.includes('national')) tier='tier_1_national';
  if (t.includes('tier 2')||t.includes('regional')) tier='tier_2_regional';
  if (t.includes('rising')||t.includes('emerging')) tier='rising_star';
  const nm = t.match(/(?:find|show|who is|profile of|tell me about|about)\s+(?:dr\.?\s+)?([a-z]+(?: [a-z]+)?)/i);
  return { disease, institution, tier, name: nm?.[1]||null };
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const C = {
  bg:"#08091A", surface:"#0E1220", card:"#131929", border:"#1A2340",
  indigo:"#6366F1", teal:"#00C2A8", indigoDim:"rgba(99,102,241,0.15)",
  tealDim:"rgba(0,194,168,0.12)", text:"#EDF2FF", muted:"#7A8599",
  success:"#10B981", warn:"#F59E0B", danger:"#EF4444",
};

const TIER_LABELS = { tier_1_national:'Tier 1 · National', tier_2_regional:'Tier 2 · Regional', tier_3_local:'Tier 3 · Local', rising_star:'Rising Star ⚡', unclassified:'Unclassified' };
const TIER_COLORS = { tier_1_national:C.indigo, tier_2_regional:C.teal, tier_3_local:C.warn, rising_star:'#EC4899', unclassified:C.muted };

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

const SERVICES = {
  kolx_premium: { id:"kolx_premium", name:"KOL X Premium", tag:"Intelligence", price:12000, unit:"/year", desc:"Full access to 500 heme-onc KOLs — custom filters, tier badges, engagement history, exportable shortlists." },
  signal:       { id:"signal",       name:"Syncofy SIGNAL", tag:"Intelligence", price:25000, unit:"/year", desc:"Weekly KOL intelligence briefs — publication alerts, trial activity, competitive payment data." },
  syncofy_intel:{ id:"syncofy_intel",name:"Syncofy Intelligence", tag:"Predictive AI", price:75000, unit:"/year", desc:"FFPS-powered predictive KOL identification. Rank next-gen KOLs before competitors." },
  ab_single:    { id:"ab_single",    name:"Advisory Board (Single)", tag:"Execution", price:15500, unit:"/event", desc:"Full STRIDE workflow. FMV-verified. Sunshine Act-ready. AI-transcribed. 2 weeks start to finish." },
  ab_annual:    { id:"ab_annual",    name:"Advisory Board Program", tag:"Execution", price:42000, unit:"/3 events", desc:"Three fully-managed advisory boards. 35% savings vs. single-event pricing." },
  speaker:      { id:"speaker",      name:"Speaker Program Support", tag:"Execution", price:8500, unit:"/event", desc:"KOL identification, FMV, compliance screening, contracting, Sunshine Act documentation." },
  kol_mapping:  { id:"kol_mapping",  name:"KOL Landscape Report", tag:"Intelligence", price:8500, unit:"one-time", desc:"Custom-built KOL landscape — top 50 ranked, tier mapping, competitive engagement history." },
  enterprise:   { id:"enterprise",   name:"Enterprise Suite", tag:"All-In", price:120000, unit:"/year", desc:"Everything: Intelligence + SIGNAL + unlimited advisory automation + dedicated CSM + API access." },
};

const LEGAL = [
  { id:"nda", name:"Mutual Non-Disclosure Agreement", abbr:"NDA", required:true, summary:"Protects both parties' confidential information. California law. 2-year term." },
  { id:"coi", name:"Conflict of Interest Declaration", abbr:"COI", required:true, summary:"Confirms no material conflict. Required for PhRMA Code compliance." },
  { id:"msa", name:"Master Services Agreement", abbr:"MSA", required:true, summary:"Governs service scope, payment terms, IP ownership, liability cap (1× annual fees)." },
  { id:"dpa", name:"Data Processing Agreement", abbr:"DPA", required:false, summary:"Required for GDPR/CCPA-subject organizations. 72hr breach notification." },
];

const LEGACY = [
  { cap:"KOL Identification", legacy:"Manual lists, static annual databases", syncofy:"AI-ranked, 8,953+ live profiles, FFPS predictive scoring" },
  { cap:"Advisory Board Execution", legacy:"6–8 week manual process, third-party vendors", syncofy:"1–2 weeks, STRIDE automation, built-in compliance" },
  { cap:"FMV Calculation", legacy:"Spreadsheet estimates, annual review cycles", syncofy:"Real-time Sullivan Cotter benchmarks, auto-documented" },
  { cap:"Sunshine Act Reporting", legacy:"Post-event manual reconciliation", syncofy:"Automated at point of engagement, audit-ready export" },
  { cap:"Emerging KOL Prediction", legacy:"None — reactive identification only", syncofy:"FFPS algorithm, 87% accuracy, 19 weighted parameters" },
  { cap:"Cost per Advisory Board", legacy:"$75K–$150K with vendor + compliance overhead", syncofy:"$15,500 fully managed, all-inclusive" },
];

const STRIPE_LINKS = {
  starter: "https://buy.stripe.com/test_starter",
  growth:  "https://buy.stripe.com/test_growth",
  enterprise: "https://buy.stripe.com/test_enterprise",
};

const QUICK_PROMPTS = ["Top AML KOLs in San Francisco","DLBCL advisory board slate","How does FFPS work?","Advisory board cost vs legacy?"];
const DISEASE_FILTERS = ["All","AML","CLL","DLBCL","Multiple Myeloma","Lymphoma","MDS","CAR-T","Myelofibrosis"];

// ── SHARED UI ─────────────────────────────────────────────────────────────────
const SIcon = ({ size=28 }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="10" fill="url(#sg)"/>
    <defs><linearGradient id="sg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
      <stop stopColor="#6366F1"/><stop offset="1" stopColor="#00C2A8"/>
    </linearGradient></defs>
    <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fill="#08091A" fontWeight="800" fontSize="22" fontFamily="'DM Sans',sans-serif">s</text>
  </svg>
);

const Tag = ({ children, color=C.muted, bg="rgba(120,130,150,0.1)" }) => (
  <span style={{ display:"inline-block", background:bg, color, fontSize:10, fontWeight:700, letterSpacing:"0.5px", textTransform:"uppercase", padding:"2px 8px", borderRadius:5 }}>{children}</span>
);

const Btn = ({ children, onClick, disabled, variant="primary", style:s={} }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: variant==="primary" ? `linear-gradient(135deg,${C.indigo},${C.teal})` : variant==="success" ? C.success : "transparent",
    color: variant==="ghost" ? C.muted : "#fff",
    border: variant==="ghost" ? `1px solid ${C.border}` : "none",
    borderRadius:12, padding:"13px 24px", fontSize:15, fontWeight:800,
    cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.45:1,
    fontFamily:"'DM Sans',sans-serif", transition:"opacity 0.15s", ...s
  }}>{children}</button>
);

const Input = ({ label, value, onChange, placeholder, type="text", hint }) => (
  <div style={{ marginBottom:14 }}>
    {label && <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:6 }}>{label}</div>}
    <input value={value} onChange={onChange} placeholder={placeholder} type={type}
      style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"11px 14px", color:C.text, fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"'DM Sans',sans-serif" }}/>
    {hint && <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{hint}</div>}
  </div>
);

const Progress = ({ step, total }) => (
  <div style={{ height:3, background:C.border }}>
    <div style={{ height:"100%", width:`${(step/total)*100}%`, background:`linear-gradient(90deg,${C.indigo},${C.teal})`, transition:"width 0.4s ease" }}/>
  </div>
);

const ScoreBar = ({ score }) => (
  <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:8 }}>
    <div style={{ flex:1, height:3, background:"rgba(255,255,255,0.06)", borderRadius:2 }}>
      <div style={{ width:`${score||0}%`, height:"100%", background:score>80?C.indigo:score>60?C.teal:C.warn, borderRadius:2 }}/>
    </div>
    <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:C.muted, minWidth:24 }}>{score??'—'}</span>
  </div>
);

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function SyncofyPlatform() {
  const [view, setView]         = useState("home");
  const [userType, setUserType] = useState(null);
  const [salesStep, setSalesStep] = useState(0);

  // Individual
  const [individual, setIndividual] = useState({ firstName:"", lastName:"", email:"", npi:"", credential:"", specialty:"", institution:"", role:"", linkedIn:"" });
  const [npiVerified, setNpiVerified] = useState(null);
  const [npiData, setNpiData]         = useState(null);

  // Company
  const [company, setCompany] = useState({ name:"", indication:"" });

  // Services + legal
  const [selectedServices, setSelectedServices] = useState([]);
  const [legal, setLegal] = useState({});
  const [dpa, setDpa]     = useState(false);

  // AI Chat
  const [msgs, setMsgs]         = useState([{ role:"assistant", content:"I'm Syncofy's AI at Pan-Hematology 2026. Ask me about KOL intelligence, advisory boards, pricing, or search any KOL by name — I have live access to 8,953 hematology-oncology providers." }]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy]   = useState(false);
  const [chatProviders, setChatProviders] = useState([]);
  const chatEnd = useRef(null);

  // Leaderboard
  const [providers, setProviders]   = useState([]);
  const [lbLoading, setLbLoading]   = useState(false);
  const [lbDisease, setLbDisease]   = useState("All");
  const [lbPage, setLbPage]         = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [lbSearch, setLbSearch]     = useState("");

  // DB status
  const [dbStatus, setDbStatus] = useState("checking");
  const [dbCount, setDbCount]   = useState("8,953");

  const [ts] = useState(new Date().toLocaleString());

  // DB health check
  useEffect(() => {
    fetch(`${SUPABASE_URL}/rest/v1/mv_provider_intelligence?select=id&is_active=eq.true`, {
      method:"HEAD",
      headers:{ apikey:SUPABASE_ANON, Authorization:`Bearer ${SUPABASE_ANON}`, Prefer:"count=exact" }
    }).then(r => {
      const cr = r.headers.get("content-range");
      const n = cr?.split("/")[1];
      setDbCount(n && n!=="*" ? parseInt(n).toLocaleString() : "8,953");
      setDbStatus("connected");
    }).catch(() => setDbStatus("error"));
  }, []);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs]);

  // Load leaderboard
  const loadLeaderboard = useCallback(async () => {
    setLbLoading(true);
    try {
      const disease = lbDisease !== "All" ? lbDisease : null;
      const name    = lbSearch.trim() || null;
      const data    = await sbFetch(buildKolQuery({ disease, name, limit:20, offset:lbPage*20 }));
      setProviders(data);
    } catch(e) { console.error(e); }
    finally { setLbLoading(false); }
  }, [lbDisease, lbSearch, lbPage]);

  useEffect(() => { if (view === "leaderboard") loadLeaderboard(); }, [view, lbDisease, lbPage]);

  // NPI lookup
  const lookupNPI = async (npiNum) => {
    if (npiNum.length !== 10 || isNaN(npiNum)) return;
    setNpiVerified("loading"); setNpiData(null);
    try {
      const res  = await fetch(`https://npiregistry.cms.hhs.gov/api/?number=${npiNum}&version=2.1`);
      const data = await res.json();
      if (data.result_count > 0) {
        const r   = data.results[0];
        const basic    = r.basic || {};
        const taxonomy = r.taxonomies?.find(t=>t.primary) || r.taxonomies?.[0] || {};
        const addr     = r.addresses?.find(a=>a.address_purpose==="LOCATION") || r.addresses?.[0] || {};
        const verified = { name:`${basic.first_name||""} ${basic.last_name||""}`.trim(), credential:basic.credential||"", specialty:taxonomy.desc||"", institution:addr.organization_name||addr.address_1||"", city:addr.city||"", state:addr.state||"", npi:npiNum };
        setNpiData(verified);
        setIndividual(p => ({ ...p, firstName:basic.first_name||p.firstName, lastName:basic.last_name||p.lastName, credential:basic.credential||p.credential, specialty:taxonomy.desc||p.specialty, institution:addr.organization_name||p.institution }));
        setNpiVerified("verified");
      } else { setNpiVerified("not_found"); }
    } catch { setNpiVerified("not_found"); }
  };

  // AI chat send
  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatBusy) return;
    setChatInput(""); setChatBusy(true);
    setMsgs(m => [...m, { role:"user", content:q }]);
    try {
      const intent = detectIntent(q);
      const rows   = await sbFetch(buildKolQuery({ name:intent.name, tier:intent.tier, disease:intent.disease, institution:intent.institution, limit:5 }));
      const ctx    = rows.length > 0
        ? `\n\nLive DB results:\n${rows.map(p=>`- ${p.first_name} ${p.last_name}${p.credentials?`, ${p.credentials}`:""} | ${p.institution_name} | ${TIER_LABELS[p.kol_tier]} | Score:${p.kol_score} | Pubs:${p.publications_count} | H-Index:${p.h_index} | Trials:${p.clinical_trials_count} | Focus:${(p.disease_focus||[]).slice(0,3).join(", ")}`).join("\n")}`
        : "";
      const resp = await fetch(CLAUDE_PROXY, {
        method:"POST",
        headers:{ "Content-Type":"application/json", apikey:SUPABASE_ANON, Authorization:`Bearer ${SUPABASE_ANON}` },
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, system:AI_SYSTEM, messages:[...msgs, { role:"user", content:q+ctx }].map(m=>({ role:m.role, content:m.content })) })
      });
      const d = await resp.json();
      setMsgs(m => [...m, { role:"assistant", content:d.content?.[0]?.text || "Reach Jason at info@syncofy.ai" }]);
      if (rows.length > 0) setChatProviders(rows.slice(0,3));
    } catch(e) {
      setMsgs(m => [...m, { role:"assistant", content:`Connection issue. Contact info@syncofy.ai` }]);
    } finally { setChatBusy(false); }
  };

  const totalPrice     = selectedServices.reduce((s,id) => s+(SERVICES[id]?.price||0), 0);
  const allLegalSigned = LEGAL.filter(d=>d.required||(d.id==="dpa"&&dpa)).every(d=>legal[d.id]);
  const profileOk      = individual.firstName && individual.lastName && individual.email;
  const getStripeLink  = () => totalPrice>=75000 ? STRIPE_LINKS.enterprise : totalPrice>=25000 ? STRIPE_LINKS.growth : STRIPE_LINKS.starter;

  // ── HEADER ─────────────────────────────────────────────────────────────────
  const Header = () => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 24px", borderBottom:`1px solid ${C.border}`, background:C.surface, position:"sticky", top:0, zIndex:100 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer" }} onClick={()=>{ setView("home"); setSalesStep(0); setUserType(null); }}>
        <SIcon size={28}/>
        <span style={{ fontWeight:800, fontSize:17, color:C.text, letterSpacing:"-0.5px", fontFamily:"'DM Sans',sans-serif" }}>Syncofy</span>
        <span style={{ fontSize:10, color:C.muted, fontWeight:600 }}>Pan-Hematology 2026</span>
      </div>
      <div style={{ display:"flex", gap:6 }}>
        {[["home","Overview"],["leaderboard","KOL X"],["sales","Get Started"]].map(([v,l]) => (
          <button key={v} onClick={()=>setView(v)} style={{ background:view===v?C.indigoDim:"transparent", border:`1px solid ${view===v?C.indigo:C.border}`, color:view===v?C.indigo:C.muted, borderRadius:8, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>{l}</button>
        ))}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:dbStatus==="connected"?C.teal:dbStatus==="error"?C.danger:C.muted }}>
        <div style={{ width:6, height:6, borderRadius:"50%", background:dbStatus==="connected"?C.teal:dbStatus==="error"?C.danger:C.muted }}/>
        {dbStatus==="connected" ? `${dbCount} live` : dbStatus==="error" ? "DB Error" : "…"}
      </div>
    </div>
  );

  const KolCard = ({ p, compact=false }) => {
    const col = TIER_COLORS[p.kol_tier]||C.muted;
    return (
      <div onClick={()=>setExpandedId(expandedId===p.id?null:p.id)}
        style={{ background:C.card, border:`1px solid ${expandedId===p.id?col:C.border}`, borderRadius:12, padding:"14px 16px", cursor:"pointer", transition:"border-color 0.15s", marginBottom:compact?0:10 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:14, color:C.text }}>{p.first_name} {p.last_name}{p.credentials?`, ${p.credentials}`:""}</div>
            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{p.institution_name}{p.city?` · ${p.city}, ${p.state}`:""}</div>
          </div>
          <span style={{ background:`${col}18`, color:col, border:`1px solid ${col}30`, borderRadius:5, padding:"2px 7px", fontSize:9, fontWeight:700, marginLeft:8, whiteSpace:"nowrap" }}>{TIER_LABELS[p.kol_tier]}</span>
        </div>
        <ScoreBar score={p.kol_score}/>
        <div style={{ display:"flex", gap:16, marginTop:10 }}>
          {[["Pubs",p.publications_count],["H-idx",p.h_index],["Trials",p.clinical_trials_count]].map(([l,v])=>(
            <div key={l} style={{ textAlign:"center" }}>
              <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:700, color:C.text }}>{v??'—'}</div>
              <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em" }}>{l}</div>
            </div>
          ))}
          <div style={{ flex:1, display:"flex", flexWrap:"wrap", gap:3, alignItems:"center" }}>
            {(p.disease_focus||[]).slice(0,2).map(d=>(
              <span key={d} style={{ background:"rgba(99,102,241,0.1)", color:"#818CF8", border:"1px solid rgba(99,102,241,0.18)", borderRadius:4, padding:"1px 5px", fontSize:9 }}>{d}</span>
            ))}
          </div>
        </div>
        {expandedId===p.id && (
          <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
            <div style={{ background:C.indigoDim, border:`1px solid rgba(99,102,241,0.2)`, borderRadius:8, padding:"10px 13px", marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.indigo, marginBottom:3 }}>🔒 Premium Intelligence Locked</div>
              <div style={{ fontSize:11, color:C.muted }}>Full engagement history, CMS Open Payments, advisory affiliations, predictive timing, and SIGNAL brief — unlock with KOL X Premium.</div>
            </div>
            <Btn onClick={e=>{e.stopPropagation();setView("sales");}} style={{ width:"100%", padding:"9px" }}>Unlock Full Profile →</Btn>
          </div>
        )}
      </div>
    );
  };

  const wrap = (content) => (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.3);border-radius:2px}`}</style>
      <Header/>{content}
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // HOME
  // ══════════════════════════════════════════════════════════════════════════
  if (view === "home") return wrap(
    <div style={{ maxWidth:760, margin:"0 auto", padding:"50px 24px 80px" }}>
      <div style={{ textAlign:"center", marginBottom:52 }}>
        <div style={{ display:"inline-block", background:C.indigoDim, border:`1px solid rgba(99,102,241,0.35)`, color:C.indigo, borderRadius:20, padding:"4px 14px", fontSize:11, fontWeight:700, letterSpacing:"1.5px", textTransform:"uppercase", marginBottom:20 }}>Pan-Hematology 2026 · San Francisco</div>
        <h1 style={{ fontSize:40, fontWeight:900, letterSpacing:"-1.5px", lineHeight:1.1, marginBottom:18, background:`linear-gradient(135deg,${C.text} 40%,${C.teal})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
          Legacy KOL Platforms Monitor.<br/>Syncofy Executes.
        </h1>
        <p style={{ fontSize:16, color:C.muted, lineHeight:1.7, maxWidth:520, margin:"0 auto 36px" }}>
          Legacy CRMs track activity. Legacy intelligence platforms sell static lists. Legacy data warehouses weren't built for Medical Affairs. Syncofy identifies, engages, pays compliantly, and predicts who's next.
        </p>
        <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
          <Btn onClick={()=>setView("leaderboard")}>Explore KOL X Leaderboard →</Btn>
          <Btn onClick={()=>setView("sales")} variant="ghost">Get Started</Btn>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:52 }}>
        {[["8,953+","H/O Providers"],["65–88%","Cost Reduction"],["1–2 wks","Advisory Timeline"],["87%","FFPS Accuracy"]].map(([v,l])=>(
          <div key={v} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:14, padding:"18px 14px", textAlign:"center" }}>
            <div style={{ fontSize:24, fontWeight:900, color:C.teal, letterSpacing:"-1px" }}>{v}</div>
            <div style={{ fontSize:11, color:C.muted, marginTop:5, lineHeight:1.4 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Comparison table */}
      <div style={{ marginBottom:52 }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Why Syncofy</div>
        <h2 style={{ fontSize:24, fontWeight:800, letterSpacing:"-0.5px", marginBottom:20 }}>Built for what legacy platforms can't do.</h2>
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", background:C.surface, padding:"10px 20px", borderBottom:`1px solid ${C.border}` }}>
            {["Capability","Legacy Platforms","Syncofy"].map((h,i)=>(
              <div key={h} style={{ fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"1px", color:i===1?C.danger:i===2?C.teal:C.muted }}>{h}</div>
            ))}
          </div>
          {LEGACY.map((r,i)=>(
            <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", padding:"13px 20px", borderBottom:i<LEGACY.length-1?`1px solid ${C.border}`:"none" }}>
              <div style={{ fontSize:12, fontWeight:600, color:C.text }}>{r.cap}</div>
              <div style={{ fontSize:11, color:"rgba(239,68,68,0.8)", lineHeight:1.5, paddingRight:12 }}>{r.legacy}</div>
              <div style={{ fontSize:11, color:C.teal, lineHeight:1.5 }}>{r.syncofy}</div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Chat */}
      <div style={{ marginBottom:52 }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.indigo, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>AI Engagement Intelligence</div>
        <h2 style={{ fontSize:24, fontWeight:800, letterSpacing:"-0.5px", marginBottom:20 }}>Ask anything. Get live answers.</h2>
        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, overflow:"hidden" }}>
          <div style={{ height:300, overflowY:"auto", padding:"18px", display:"flex", flexDirection:"column", gap:10 }}>
            {msgs.map((m,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                {m.role==="assistant" && <div style={{ width:26, height:26, borderRadius:7, background:`linear-gradient(135deg,${C.indigo},${C.teal})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:C.bg, marginRight:9, flexShrink:0, marginTop:2 }}>s</div>}
                <div style={{ maxWidth:"76%", background:m.role==="user"?C.indigoDim:C.surface, border:`1px solid ${m.role==="user"?"rgba(99,102,241,0.3)":C.border}`, borderRadius:m.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px", padding:"9px 13px", fontSize:13, color:m.role==="user"?C.indigo:C.text, lineHeight:1.6 }}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatBusy && (
              <div style={{ display:"flex", gap:9, alignItems:"center" }}>
                <div style={{ width:26, height:26, borderRadius:7, background:`linear-gradient(135deg,${C.indigo},${C.teal})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:C.bg }}>s</div>
                <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:"14px 14px 14px 4px", padding:"9px 14px", fontSize:13, color:C.muted }}>Thinking…</div>
              </div>
            )}
            {chatProviders.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {chatProviders.map(p=><KolCard key={p.id} p={p} compact/>)}
              </div>
            )}
            <div ref={chatEnd}/>
          </div>
          <div style={{ borderTop:`1px solid ${C.border}`, display:"flex", gap:8, padding:"10px 14px" }}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()}
              placeholder="Ask about KOLs, advisory boards, pricing, FFPS…"
              style={{ flex:1, background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, padding:"9px 13px", color:C.text, fontSize:13, outline:"none", fontFamily:"'DM Sans',sans-serif" }}/>
            <button onClick={sendChat} disabled={chatBusy||!chatInput.trim()} style={{ background:`linear-gradient(135deg,${C.indigo},${C.teal})`, color:"#fff", border:"none", borderRadius:9, padding:"9px 16px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:chatBusy||!chatInput.trim()?0.5:1, fontFamily:"'DM Sans',sans-serif" }}>Send</button>
          </div>
          <div style={{ borderTop:`1px solid ${C.border}`, padding:"8px 14px", display:"flex", gap:8, flexWrap:"wrap" }}>
            {QUICK_PROMPTS.map(q=>(
              <button key={q} onClick={()=>setChatInput(q)} style={{ background:C.indigoDim, border:`1px solid rgba(99,102,241,0.25)`, color:C.indigo, borderRadius:20, padding:"3px 11px", fontSize:11, cursor:"pointer", fontWeight:600, fontFamily:"'DM Sans',sans-serif" }}>{q}</button>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div style={{ background:`linear-gradient(135deg,rgba(99,102,241,0.1),rgba(0,194,168,0.08))`, border:`1px solid rgba(99,102,241,0.25)`, borderRadius:20, padding:"36px 32px", textAlign:"center" }}>
        <h2 style={{ fontSize:26, fontWeight:800, letterSpacing:"-0.5px", marginBottom:10 }}>See your KOLs ranked live. Then let's close.</h2>
        <p style={{ fontSize:14, color:C.muted, marginBottom:24 }}>{dbCount} hematology-oncology providers. Live data. No legacy lag.</p>
        <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
          <Btn onClick={()=>setView("leaderboard")}>Open KOL X →</Btn>
          <Btn onClick={()=>setView("sales")} variant="ghost">Get Started</Btn>
        </div>
      </div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════════════════════
  if (view === "leaderboard") return wrap(
    <div style={{ maxWidth:800, margin:"0 auto", padding:"36px 24px 80px" }}>
      <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:8 }}>KOL X · Pan-Hematology 2026</div>
      <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-1px", marginBottom:6 }}>Hematology-Oncology Intelligence</h1>
      <p style={{ fontSize:13, color:C.muted, marginBottom:24 }}>{dbCount} providers profiled nationally · Live rankings</p>

      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        <input value={lbSearch} onChange={e=>setLbSearch(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loadLeaderboard()}
          placeholder="Search by name…"
          style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:9, padding:"7px 12px", color:C.text, fontSize:13, outline:"none", fontFamily:"'DM Sans',sans-serif", width:180 }}/>
        {DISEASE_FILTERS.map(s=>(
          <button key={s} onClick={()=>{ setLbDisease(s); setLbPage(0); }} style={{ background:lbDisease===s?C.indigoDim:"transparent", border:`1px solid ${lbDisease===s?C.indigo:C.border}`, color:lbDisease===s?C.indigo:C.muted, borderRadius:20, padding:"5px 13px", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>{s}</button>
        ))}
      </div>

      {lbLoading
        ? <div style={{ color:C.muted, textAlign:"center", padding:60, fontSize:13 }}>Loading from live database…</div>
        : <>
            {providers.map(p => <KolCard key={p.id} p={p}/>)}
            {providers.length === 0 && <div style={{ color:C.muted, textAlign:"center", padding:40 }}>No results — try a different filter.</div>}
            <div style={{ display:"flex", gap:8, justifyContent:"center", marginTop:16 }}>
              {lbPage > 0 && <Btn onClick={()=>setLbPage(p=>p-1)} variant="ghost" style={{ padding:"8px 16px", fontSize:12 }}>← Prev</Btn>}
              {providers.length===20 && <Btn onClick={()=>setLbPage(p=>p+1)} style={{ padding:"8px 16px", fontSize:12 }}>Next →</Btn>}
            </div>
          </>
      }

      <div style={{ background:C.card, border:`1px dashed ${C.border}`, borderRadius:14, padding:"22px", textAlign:"center", marginTop:16 }}>
        <div style={{ fontSize:13, color:C.muted, marginBottom:12 }}>+ Thousands more providers · Filter by trial site, publication count, FMV tier, congress presence</div>
        <Btn onClick={()=>setView("sales")}>Get Full Access →</Btn>
      </div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // SALES FLOW
  // ══════════════════════════════════════════════════════════════════════════
  if (view === "sales") return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <Header/>
      <Progress step={salesStep} total={4}/>
      <div style={{ maxWidth:660, margin:"0 auto", padding:"36px 24px 100px" }}>

        {/* STEP 0a — Who are you */}
        {salesStep===0 && !userType && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 1 of 4</div>
            <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Who are you joining as?</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:32 }}>We'll tailor your experience and build your verified Syncofy profile.</p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
              {[{ type:"pharma", icon:"💊", title:"Pharma / Biotech Professional", desc:"Medical Affairs, Commercial Strategy, BD, Clinical Operations, C-Suite" },
                { type:"physician", icon:"🩺", title:"Physician / Researcher", desc:"Oncologist, Hematologist, Fellow, Academic Researcher, Clinical PI" }].map(opt=>(
                <div key={opt.type} onClick={()=>setUserType(opt.type)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:"24px 20px", cursor:"pointer", textAlign:"center" }}>
                  <div style={{ fontSize:40, marginBottom:14 }}>{opt.icon}</div>
                  <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>{opt.title}</div>
                  <div style={{ fontSize:12, color:C.muted, lineHeight:1.5 }}>{opt.desc}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* STEP 0b — Profile */}
        {salesStep===0 && userType && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 1 of 4 — Your Profile</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>{userType==="physician"?"Build your verified clinician profile.":"Tell us about yourself."}</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:28 }}>{userType==="physician"?"Enter your NPI to auto-verify from CMS registry in real time.":"We'll use this to personalize recommendations and pre-fill agreements."}</p>

            {userType==="physician" && (
              <div style={{ background:"rgba(99,102,241,0.06)", border:`1px solid rgba(99,102,241,0.25)`, borderRadius:14, padding:"18px 20px", marginBottom:24 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.indigo, marginBottom:12 }}>🔍 NPI Registry Auto-Verify</div>
                <div style={{ display:"flex", gap:10 }}>
                  <input value={individual.npi} onChange={e=>setIndividual(p=>({...p,npi:e.target.value}))} placeholder="10-digit NPI"
                    style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:9, padding:"10px 13px", color:C.text, fontSize:14, outline:"none", fontFamily:"'DM Sans',sans-serif" }}/>
                  <button onClick={()=>lookupNPI(individual.npi)} disabled={individual.npi.length!==10}
                    style={{ background:`linear-gradient(135deg,${C.indigo},${C.teal})`, color:"#fff", border:"none", borderRadius:9, padding:"10px 18px", fontSize:13, fontWeight:700, cursor:"pointer", opacity:individual.npi.length===10?1:0.45, fontFamily:"'DM Sans',sans-serif" }}>Verify</button>
                </div>
                {npiVerified==="loading" && <div style={{ fontSize:12, color:C.muted, marginTop:8 }}>Checking NPI Registry…</div>}
                {npiVerified==="not_found" && <div style={{ fontSize:12, color:C.danger, marginTop:8 }}>NPI not found — fill in manually below.</div>}
                {npiVerified==="verified" && npiData && (
                  <div style={{ marginTop:10, background:"rgba(16,185,129,0.08)", border:`1px solid rgba(16,185,129,0.3)`, borderRadius:9, padding:"10px 14px" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:C.success, marginBottom:4 }}>✓ Verified via CMS NPI Registry</div>
                    <div style={{ fontSize:13, color:C.text }}><strong>{npiData.name}</strong>{npiData.credential?`, ${npiData.credential}`:""}</div>
                    <div style={{ fontSize:12, color:C.muted }}>{npiData.specialty}</div>
                    <div style={{ fontSize:12, color:C.muted }}>{npiData.institution}{npiData.city?` · ${npiData.city}, ${npiData.state}`:""}</div>
                  </div>
                )}
                <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>Public data only. Enables Sunshine Act compliance and KOL profile matching.</div>
              </div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <Input label="First Name" value={individual.firstName} onChange={e=>setIndividual(p=>({...p,firstName:e.target.value}))} placeholder="First"/>
              <Input label="Last Name" value={individual.lastName} onChange={e=>setIndividual(p=>({...p,lastName:e.target.value}))} placeholder="Last"/>
              <div style={{ gridColumn:"1/-1" }}><Input label="Work Email" value={individual.email} onChange={e=>setIndividual(p=>({...p,email:e.target.value}))} placeholder="you@company.com" type="email"/></div>
              <Input label="Credential" value={individual.credential} onChange={e=>setIndividual(p=>({...p,credential:e.target.value}))} placeholder="MD, DO, PhD…"/>
              <Input label="Specialty" value={individual.specialty} onChange={e=>setIndividual(p=>({...p,specialty:e.target.value}))} placeholder="CLL, AML, Lymphoma…"/>
              <div style={{ gridColumn:"1/-1" }}><Input label="Institution" value={individual.institution} onChange={e=>setIndividual(p=>({...p,institution:e.target.value}))} placeholder="Hospital, pharma, or academic center"/></div>
            </div>

            {userType==="pharma" && (
              <>
                <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:6 }}>Your Role</div>
                <select value={individual.role} onChange={e=>setIndividual(p=>({...p,role:e.target.value}))}
                  style={{ width:"100%", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"11px 14px", color:individual.role?C.text:C.muted, fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"'DM Sans',sans-serif", appearance:"none", marginBottom:14 }}>
                  <option value="">Select role…</option>
                  {["Medical Affairs Director","VP Medical Affairs","MSL / Field Medical","Commercial Strategy","Business Development","C-Suite / Founder","Clinical Operations","Market Access"].map(r=><option key={r} value={r}>{r}</option>)}
                </select>
                <Input label="Company" value={company.name} onChange={e=>setCompany(p=>({...p,name:e.target.value}))} placeholder="BeiGene, Iovance, Legend Biotech…"/>
                <Input label="Primary Indication" value={company.indication} onChange={e=>setCompany(p=>({...p,indication:e.target.value}))} placeholder="CLL, DLBCL, Multiple Myeloma…"/>
              </>
            )}

            <Input label="LinkedIn (optional)" value={individual.linkedIn} onChange={e=>setIndividual(p=>({...p,linkedIn:e.target.value}))} placeholder="linkedin.com/in/yourname" hint="Helps match your clinical and publication profile."/>

            <div style={{ display:"flex", gap:10, marginTop:8 }}>
              <Btn onClick={()=>setUserType(null)} variant="ghost">← Back</Btn>
              <Btn onClick={()=>setSalesStep(userType==="physician"?3:1)} disabled={!profileOk} style={{ flex:1 }}>
                {userType==="physician"?"Register as KOL →":"Continue →"}
              </Btn>
            </div>
          </>
        )}

        {/* STEP 1 — Services */}
        {salesStep===1 && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 2 of 4 — Services</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Build your engagement stack.</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:24 }}>Select everything that applies to {company.name||"your organization"}.</p>

            <div style={{ background:"rgba(245,158,11,0.06)", border:`1px solid rgba(245,158,11,0.3)`, borderRadius:14, padding:"16px 18px", marginBottom:20 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.warn, marginBottom:6 }}>💡 Most Popular: Launch Intelligence Pack</div>
              <div style={{ fontSize:13, color:C.muted, marginBottom:10 }}>KOL Landscape + SIGNAL + Advisory Board — <span style={{ color:C.warn, fontWeight:700 }}>$42,000</span> <span style={{ textDecoration:"line-through", opacity:0.6 }}>$49,500</span> · Save $7,500</div>
              <button onClick={()=>setSelectedServices(["kol_mapping","signal","ab_single"])}
                style={{ background:"rgba(245,158,11,0.15)", border:`1px solid rgba(245,158,11,0.4)`, color:C.warn, borderRadius:8, padding:"5px 13px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}>Select Bundle</button>
            </div>

            {Object.values(SERVICES).map(s=>{
              const active = selectedServices.includes(s.id);
              const tagMap = { "Predictive AI":[C.indigoDim,C.indigo], "Execution":[C.tealDim,C.teal], "All-In":["rgba(245,158,11,0.12)",C.warn], "Intelligence":["rgba(120,130,150,0.1)",C.muted] };
              const [tbg,tco] = tagMap[s.tag]||tagMap.Intelligence;
              return (
                <div key={s.id} onClick={()=>setSelectedServices(p=>p.includes(s.id)?p.filter(x=>x!==s.id):[...p,s.id])}
                  style={{ background:active?C.indigoDim:C.card, border:`1px solid ${active?C.indigo:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:10, cursor:"pointer", display:"flex", gap:13, alignItems:"flex-start" }}>
                  <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${active?C.indigo:C.border}`, background:active?C.indigo:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                    {active && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
                  </div>
                  <div style={{ flex:1 }}>
                    <Tag bg={tbg} color={tco}>{s.tag}</Tag>
                    <div style={{ fontSize:15, fontWeight:700, marginTop:5, marginBottom:4 }}>{s.name}</div>
                    <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>{s.desc}</div>
                  </div>
                  <div style={{ textAlign:"right", flexShrink:0 }}>
                    <div style={{ fontSize:19, fontWeight:900, color:C.teal }}>${s.price.toLocaleString()}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{s.unit}</div>
                  </div>
                </div>
              );
            })}

            {selectedServices.length>0 && (
              <div style={{ background:C.card, border:`1px solid ${C.teal}`, borderRadius:12, padding:"15px 18px", display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:4 }}>
                <div>
                  <div style={{ fontWeight:700 }}>Your Investment</div>
                  <div style={{ fontSize:12, color:C.success }}>vs. ~${(totalPrice*3).toLocaleString()} legacy vendor equivalent</div>
                </div>
                <div style={{ fontSize:26, fontWeight:900, color:C.teal }}>${totalPrice.toLocaleString()}</div>
              </div>
            )}

            <div style={{ display:"flex", gap:10, marginTop:20 }}>
              <Btn onClick={()=>setSalesStep(0)} variant="ghost">← Back</Btn>
              <Btn onClick={()=>setSalesStep(2)} disabled={selectedServices.length===0} style={{ flex:1 }}>Proceed to Agreements →</Btn>
            </div>
          </>
        )}

        {/* STEP 2 — Legal */}
        {salesStep===2 && (
          <>
            <div style={{ fontSize:11, fontWeight:700, color:C.teal, letterSpacing:"2px", textTransform:"uppercase", marginBottom:10 }}>Step 3 of 4 — Agreements</div>
            <h1 style={{ fontSize:28, fontWeight:900, letterSpacing:"-0.5px", marginBottom:8 }}>Let's protect both of us.</h1>
            <p style={{ fontSize:14, color:C.muted, marginBottom:28 }}>
              <strong style={{ color:C.text }}>{individual.firstName} {individual.lastName}</strong> confirms authority to bind <strong style={{ color:C.text }}>{company.name||"your organization"}</strong>. Countersigned copies sent to <strong style={{ color:C.text }}>{individual.email}</strong> within 24 hours.
            </p>

            {LEGAL.filter(d=>d.required||(d.id==="dpa"&&dpa)).map(d=>{
              const checked = legal[d.id];
              return (
                <div key={d.id} onClick={()=>setLegal(p=>({...p,[d.id]:!p[d.id]}))}
                  style={{ display:"flex", gap:13, alignItems:"flex-start", background:checked?"rgba(16,185,129,0.06)":C.card, border:`1px solid ${checked?C.success:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:12, cursor:"pointer" }}>
                  <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${checked?C.success:C.border}`, background:checked?C.success:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                    {checked && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
                  </div>
                  <div>
                    <div style={{ fontWeight:700, marginBottom:4, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                      {d.name}
                      <span style={{ fontSize:10, background:C.border, color:C.muted, padding:"1px 6px", borderRadius:4 }}>{d.abbr}</span>
                      {d.required && <span style={{ fontSize:10, color:C.danger, fontWeight:700 }}>REQUIRED</span>}
                    </div>
                    <div style={{ fontSize:13, color:C.muted, lineHeight:1.6 }}>{d.summary}</div>
                  </div>
                </div>
              );
            })}

            <div onClick={()=>setDpa(p=>!p)}
              style={{ display:"flex", gap:13, alignItems:"flex-start", background:C.card, border:`1px solid ${dpa?C.indigo:C.border}`, borderRadius:12, padding:"15px 17px", marginBottom:20, cursor:"pointer" }}>
              <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${dpa?C.indigo:C.border}`, background:dpa?C.indigo:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:2 }}>
                {dpa && <span style={{ color:"#fff", fontSize:13 }}>✓</span>}
              </div>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Add DPA (GDPR / CCPA) <span style={{ fontSize:11, color:C.muted, fontWeight:400 }}>— Optional</span></div>
                <div style={{ fontSize:13, color:C.muted }}>Required if your organization is subject to GDPR or CCPA regulations.</div>
              </div>
            </div>

            <div style={{ background:"rgba(245,158,11,0.06)", border:`1px solid rgba(245,158,11,0.25)`, borderRadius:10, padding:"12px 15px", marginBottom:20 }}>
              <div style={{ fontSize:11, color:C.warn, fontWeight:700, marginBottom:4 }}>⚠ No payment obligation created by this acknowledgment alone.</div>
              <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>Fully executed documents within 24 hours. Syncofy, LLC · Jason Yonehiro, CEO · info@syncofy.ai</div>
            </div>

            <div style={{ display:"flex", gap:10 }}>
              <Btn onClick={()=>setSalesStep(1)} variant="ghost">← Back</Btn>
              <Btn onClick={()=>setSalesStep(3)} disabled={!allLegalSigned} style={{ flex:1 }}>✓ Confirm & Lock In Deal</Btn>
            </div>
          </>
        )}

        {/* STEP 3 — Confirmation */}
        {salesStep===3 && (
          <div style={{ textAlign:"center", paddingTop:12 }}>
            <div style={{ fontSize:60, marginBottom:20 }}>{userType==="physician"?"🏆":"🎯"}</div>
            <h1 style={{ fontSize:30, fontWeight:900, letterSpacing:"-1px", marginBottom:10 }}>
              {userType==="physician"?`Welcome to KOL X, Dr. ${individual.lastName}.`:`You're in, ${individual.firstName}.`}
            </h1>
            <p style={{ fontSize:14, color:C.muted, maxWidth:440, margin:"0 auto 32px", lineHeight:1.7 }}>
              {userType==="physician"
                ?`Your verified profile has been captured. Syncofy will send your KOL X ranking and engagement opportunities to ${individual.email}.`
                :`Jason will send executed documents and platform access to ${individual.email} within 24 hours.`}
            </p>

            <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:"22px 24px", textAlign:"left", marginBottom:16 }}>
              <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"1px", marginBottom:14 }}>
                {userType==="physician"?"Verified Profile":"Deal Summary"}
              </div>
              {[
                ["Name",`${individual.firstName} ${individual.lastName}${individual.credential?`, ${individual.credential}`:""}`],
                ["Email",individual.email],
                individual.npi&&["NPI",`${individual.npi} ${npiVerified==="verified"?"✓ CMS Verified":""}`],
                individual.specialty&&["Specialty",individual.specialty],
                individual.institution&&["Institution",individual.institution],
                userType==="pharma"&&company.name&&["Company",company.name],
                userType==="pharma"&&selectedServices.length>0&&["Services",selectedServices.map(id=>SERVICES[id]?.name).join(", ")],
              ].filter(Boolean).map(([k,v])=>(
                <div key={k} style={{ display:"flex", gap:12, marginBottom:8, fontSize:13 }}>
                  <span style={{ color:C.muted, minWidth:90 }}>{k}</span>
                  <span style={{ color:C.text, fontWeight:600 }}>{v}</span>
                </div>
              ))}
              {userType==="pharma"&&totalPrice>0&&(
                <div style={{ borderTop:`1px solid ${C.border}`, marginTop:14, paddingTop:14, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontWeight:700 }}>Investment</span>
                  <span style={{ fontSize:26, fontWeight:900, color:C.teal }}>${totalPrice.toLocaleString()}</span>
                </div>
              )}
            </div>

            {userType==="pharma"&&(
              <div style={{ background:"rgba(16,185,129,0.06)", border:`1px solid rgba(16,185,129,0.3)`, borderRadius:12, padding:"13px 17px", textAlign:"left", marginBottom:16 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.success, marginBottom:8 }}>✓ Legal Acknowledgments Captured · {ts}</div>
                {LEGAL.filter(d=>legal[d.id]).map(d=>(
                  <div key={d.id} style={{ fontSize:12, color:C.muted, marginBottom:3 }}>· {d.name} ({d.abbr})</div>
                ))}
              </div>
            )}

            {userType==="pharma"&&totalPrice>0&&(
              <div style={{ background:"rgba(99,102,241,0.06)", border:`1px solid rgba(99,102,241,0.25)`, borderRadius:14, padding:"20px", marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.indigo, marginBottom:8 }}>💳 Optional: Pay Now to Activate Immediately</div>
                <div style={{ fontSize:12, color:C.muted, marginBottom:16 }}>Activate your Syncofy account today. Secure checkout via Stripe.</div>
                <Btn onClick={()=>window.open(getStripeLink(),"_blank")} variant="success" style={{ width:"100%" }}>Pay ${totalPrice.toLocaleString()} via Stripe →</Btn>
                <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>Or: Jason will send an invoice to {individual.email} within 24 hours.</div>
              </div>
            )}

            <div style={{ fontSize:13, color:C.muted }}>Questions? <strong style={{ color:C.text }}>info@syncofy.ai</strong> · Jason Yonehiro, CEO</div>
          </div>
        )}
      </div>
    </div>
  );
}
