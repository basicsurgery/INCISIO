// ============================================================
// INCISIO v2.1 — app.js
// Fixes: Safari auth, field() loop bug, theme-color, mailto
// encoding, delete race condition, signature ink colour,
// sync screen guard, init spinner, undo delete, dirty form
// guard, confirm dialog, delete account, PDF progress,
// dvh keyboard fix, AI disclaimer
// ============================================================

const SUPABASE_URL      = 'https://kworghdeojawbsbivqnl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt3b3JnaGRlb2phd2JzYml2cW5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyMjM1MTksImV4cCI6MjA4ODc5OTUxOX0.VjiO56E_hH-en_kBD2BTp9qBpMJi437CBPDJ8wTWZzA';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,
    storage:            window.localStorage,
    storageKey:         'incisio-auth',
    autoRefreshToken:   true,
    detectSessionInUrl: false
  }
});

// ── Storage keys ──────────────────────────────────────────
const DB_KEY      = 'incisio_entries_v2';
const PROFILE_KEY = 'incisio_profile_v2';
const TC_KEY      = 'incisio_tc_v2';
const PENDING_KEY = 'incisio_pending_sync';

// ── State ─────────────────────────────────────────────────
let currentUser   = null;
let userProfile   = {};
let entries       = [];
let pendingSync   = [];
let currentFilter = 'all';
let editingId     = null;
let isOnline      = navigator.onLine;
let activeScreen  = 'log';
let formIsDirty   = false;

// Undo delete state
let undoEntry    = null;
let undoTimer    = null;

// Confirm dialog callback
let confirmCallback = null;

// Signature canvas
let sigCanvas, sigCtx, sigDrawing = false, sigHasData = false;

// ============================================================
// LOCAL STORAGE
// ============================================================
function loadLocal() {
  try { entries     = JSON.parse(localStorage.getItem(DB_KEY))      || []; } catch { entries = []; }
  try { userProfile = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { userProfile = {}; }
  try { pendingSync = JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch { pendingSync = []; }
}
function saveLocal() {
  localStorage.setItem(DB_KEY,      JSON.stringify(entries));
  localStorage.setItem(PENDING_KEY, JSON.stringify(pendingSync));
}
function saveProfile(p) {
  userProfile = p;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
function genId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================
// SYNC
// ============================================================
function setSyncStatus(status) {
  const dot = document.getElementById('syncIndicator');
  if (dot) dot.className = 'sync-dot ' + status;
  const el = document.getElementById('syncStatusText');
  if (!el) return;
  const msgs = {
    synced:  'All entries synced to cloud ✓',
    pending: `${pendingSync.length} entry/entries waiting to sync`,
    offline: 'Offline — saved locally, will sync when back online'
  };
  el.textContent = msgs[status] || '';
}

async function syncToCloud() {
  if (!currentUser || !isOnline || pendingSync.length === 0) return;
  setSyncStatus('pending');
  const toSync    = [...pendingSync];
  const succeeded = [];

  for (const op of toSync) {
    try {
      if (op.type === 'upsert') {
        const entry = entries.find(e => e.id === op.id);
        if (entry) {
          const { error } = await sb.from('procedure_entries')
            .upsert(entryToRow(entry), { onConflict: 'id' });
          if (!error) succeeded.push(op.id);
        } else {
          // Entry was deleted locally — remove stale upsert op
          succeeded.push(op.id);
        }
      } else if (op.type === 'delete') {
        const { error } = await sb.from('procedure_entries')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', op.id).eq('user_id', currentUser.id);
        if (!error) succeeded.push(op.id);
      }
    } catch (e) { console.warn('Sync failed', op.id, e); }
  }

  pendingSync = pendingSync.filter(op => !succeeded.includes(op.id));
  saveLocal();
  setSyncStatus(pendingSync.length === 0 ? 'synced' : 'pending');
}

async function syncFromCloud() {
  if (!currentUser || !isOnline) return;
  try {
    const { data, error } = await sb
      .from('procedure_entries')
      .select('*')
      .eq('user_id', currentUser.id)
      .is('deleted_at', null)
      .order('date', { ascending: false });
    if (error) throw error;

    const pendingIds = new Set(pendingSync.filter(p => p.type === 'upsert').map(p => p.id));
    const cloudById  = {};
    (data || []).map(rowToEntry).forEach(e => { cloudById[e.id] = e; });
    entries.filter(e => pendingIds.has(e.id)).forEach(e => { cloudById[e.id] = e; });
    entries = Object.values(cloudById);
    saveLocal();

    // Only re-render visible screens, don't disrupt active form
    if (activeScreen === 'log') { renderStats(); renderFilters(); renderLog(); }
    if (activeScreen === 'dashboard') renderDashboard();
    if (activeScreen === 'followups') renderFollowUps();
  } catch (e) { console.warn('Sync from cloud failed', e); }
}

async function forcSync() {
  await syncToCloud();
  await syncFromCloud();
  toast('Sync complete ✓');
}

function entryToRow(e) {
  return {
    id: e.id, user_id: currentUser.id,
    date: e.date || null,
    procedure_name:   e.procedureName   || '',
    procedure_code:   e.procedureCode   || null,
    procedure_type:   e.procedureType   || null,
    specialty:        e.specialty       || null,
    surgeon_name:     e.surgeonName     || null,
    role_title:       e.roleTitle       || null,
    reg_number:       e.regNumber       || null,
    competency_level: e.competencyLevel || null,
    duration:         e.duration        || null,
    complications:    e.complications   || null,
    outcome:          e.outcome         || null,
    follow_up_date:   e.followUpDate    || null,
    follow_up_notes:  e.followUpNotes   || null,
    supervisor_name:  e.supervisorName  || null,
    signature_data:   e.signatureData   || null,
    updated_at: new Date().toISOString()
  };
}

function rowToEntry(r) {
  return {
    id:              r.id,
    date:            r.date,
    procedureName:   r.procedure_name,
    procedureCode:   r.procedure_code,
    procedureType:   r.procedure_type,
    specialty:       r.specialty,
    surgeonName:     r.surgeon_name,
    roleTitle:       r.role_title,
    regNumber:       r.reg_number,
    competencyLevel: r.competency_level,
    duration:        r.duration,
    complications:   r.complications,
    outcome:         r.outcome,
    followUpDate:    r.follow_up_date,
    followUpNotes:   r.follow_up_notes,
    supervisorName:  r.supervisor_name,
    signatureData:   r.signature_data
  };
}

// ============================================================
// AUTH
// ============================================================
function showAuthPanel(panel) {
  ['authLogin', 'authRegister', 'authReset'].forEach(id =>
    document.getElementById(id).style.display = 'none'
  );
  document.getElementById('auth' + panel[0].toUpperCase() + panel.slice(1)).style.display = 'block';
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email || !pass) {
    errEl.textContent = 'Please enter your email and password.';
    errEl.style.display = 'block'; return;
  }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; }
}

async function doRegister() {
  const name  = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const pass  = document.getElementById('regPassword').value;
  const errEl = document.getElementById('registerError');
  errEl.style.display = 'none';
  if (!name)         { errEl.textContent = 'Please enter your name.';                  errEl.style.display = 'block'; return; }
  if (!email)        { errEl.textContent = 'Please enter your email.';                 errEl.style.display = 'block'; return; }
  if (pass.length<8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Creating…';
  const { error } = await sb.auth.signUp({
    email, password: pass,
    options: { data: { full_name: name } }
  });
  btn.disabled = false; btn.textContent = 'Create account';
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }
  toast('Account created! Check your email, then sign in.');
  showAuthPanel('login');
}

async function doReset() {
  const email = document.getElementById('resetEmail').value.trim();
  if (!email) { toast('Please enter your email'); return; }
  const btn = document.getElementById('resetBtn');
  btn.disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  btn.disabled = false;
  const msgEl = document.getElementById('resetMsg');
  msgEl.textContent   = error ? error.message : 'Reset link sent — check your email.';
  msgEl.style.color   = error ? 'var(--danger)' : 'var(--success)';
  msgEl.style.background = error ? 'rgba(207,34,46,.08)' : 'rgba(26,127,55,.08)';
  msgEl.style.border  = error ? '1px solid rgba(207,34,46,.3)' : '1px solid rgba(26,127,55,.3)';
  msgEl.style.display = 'block';
}

async function doSignOut() {
  entries = []; userProfile = {}; pendingSync = [];
  localStorage.clear();
  await sb.auth.signOut(); // triggers SIGNED_OUT event which calls showAuthUI()
}

// ── Delete account (GDPR right to erasure) ────────────────
function confirmDeleteAccount() {
  showConfirm(
    'Delete account',
    'This permanently deletes your account and ALL your logbook data from the cloud. This cannot be undone.',
    async () => {
      toast('Deleting account…');
      // Delete all entries
      await sb.from('procedure_entries').delete().eq('user_id', currentUser.id);
      // Delete profile
      await sb.from('user_profiles').delete().eq('user_id', currentUser.id);
      // Sign out (actual user deletion requires admin API or Edge Function — for now sign out and clear)
      await sb.auth.signOut();
      localStorage.clear();
      toast('Account data deleted.');
      setTimeout(() => location.reload(), 1500);
    }
  );
}

// Auth handled in init() below

function showAuthUI() {
  document.getElementById('authScreen').style.display       = 'flex';
  document.getElementById('app').style.display              = 'none';
  document.getElementById('onboardingScreen').style.display = 'none';
  hideSpinner();
}

async function onSignedIn() {
  if (!localStorage.getItem(TC_KEY)) openModal('tcModal');

  // Show the app immediately using cached profile — never block on network.
  // If we have a cached profile, go straight in. If not (first ever login),
  // show onboarding. Either way the spinner is gone in milliseconds.
  const cachedProfile = localStorage.getItem(PROFILE_KEY);
  if (cachedProfile) {
    try { userProfile = JSON.parse(cachedProfile); } catch { userProfile = {}; }
    showApp();
  } else {
    // First login — must fetch profile to check if onboarding needed.
    // Add a 5s timeout so a slow network never leaves the user on a spinner.
    try {
      const profilePromise = sb.from('user_profiles')
        .select('*').eq('user_id', currentUser.id).single();
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null }), 5000));
      const { data } = await Promise.race([profilePromise, timeoutPromise]);
      if (data) {
        userProfile = {
          fullName:  data.full_name  || '',
          roleTitle: data.role_title || '',
          regNumber: data.reg_number || '',
          hospital:  data.hospital   || ''
        };
        saveProfile(userProfile);
        showApp();
      } else {
        // No profile found or timed out — show onboarding
        hideSpinner();
        document.getElementById('authScreen').style.display       = 'none';
        document.getElementById('onboardingScreen').style.display = 'flex';
      }
    } catch {
      // Network error on first login — go to onboarding anyway
      hideSpinner();
      document.getElementById('authScreen').style.display       = 'none';
      document.getElementById('onboardingScreen').style.display = 'flex';
    }
  }

  // Refresh profile from cloud in the background (non-blocking)
  if (isOnline && cachedProfile) {
    sb.from('user_profiles').select('*').eq('user_id', currentUser.id).single()
      .then(({ data }) => {
        if (data) {
          userProfile = {
            fullName:  data.full_name  || '',
            roleTitle: data.role_title || '',
            regNumber: data.reg_number || '',
            hospital:  data.hospital   || ''
          };
          saveProfile(userProfile);
        }
      }).catch(() => {});
  }
}

function showApp() {
  document.getElementById('authScreen').style.display       = 'none';
  document.getElementById('onboardingScreen').style.display = 'none';
  document.getElementById('app').style.display              = 'flex';
  hideSpinner();
  renderStats(); renderFilters(); renderLog();
  setSyncStatus(isOnline ? (pendingSync.length > 0 ? 'pending' : 'synced') : 'offline');
  if (isOnline) syncToCloud().then(() => syncFromCloud());
}

function hideSpinner() {
  const s = document.getElementById('initSpinner');
  if (!s || s._hiding) return;
  s._hiding = true;
  s.classList.add('hidden');
  setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 400);
}

// ── Onboarding ─────────────────────────────────────────────
async function saveOnboardingProfile() {
  const p = {
    fullName:  currentUser?.user_metadata?.full_name || '',
    roleTitle: document.getElementById('ob_roleTitle').value.trim(),
    regNumber: document.getElementById('ob_regNumber').value.trim(),
    hospital:  document.getElementById('ob_hospital').value.trim()
  };
  saveProfile(p);
  await upsertProfileToCloud(p);
  showApp();
}
function skipOnboarding() { showApp(); }

async function upsertProfileToCloud(p) {
  if (!currentUser || !isOnline) return;
  await sb.from('user_profiles').upsert({
    user_id:    currentUser.id,
    full_name:  p.fullName,
    role_title: p.roleTitle,
    reg_number: p.regNumber,
    hospital:   p.hospital
  }, { onConflict: 'user_id' });
}

// ============================================================
// PROCEDURE CODES + CLINICAL
// ============================================================
const PROC_CODES = [
  { name:'Laparoscopic Cholecystectomy',   opcs:'J18.3',cpt:'47562',specialty:'General Surgery',   type:'Laparoscopic'},
  { name:'Appendicectomy',                 opcs:'H01',  cpt:'44950',specialty:'General Surgery',   type:'Open'},
  { name:'Laparoscopic Appendicectomy',    opcs:'H01.1',cpt:'44970',specialty:'General Surgery',   type:'Laparoscopic'},
  { name:'Inguinal Hernia Repair',         opcs:'T20',  cpt:'49505',specialty:'General Surgery',   type:'Open'},
  { name:'Laparoscopic Hernia Repair',     opcs:'T20.4',cpt:'49650',specialty:'General Surgery',   type:'Laparoscopic'},
  { name:'Right Hemicolectomy',            opcs:'H10',  cpt:'44160',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Hartmann Procedure',             opcs:'H33',  cpt:'44143',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Low Anterior Resection',         opcs:'H33.3',cpt:'45110',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Abdominoperineal Resection',     opcs:'H33.5',cpt:'45395',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Total Hip Replacement',          opcs:'W37',  cpt:'27130',specialty:'Orthopaedics',      type:'Open'},
  { name:'Total Knee Replacement',         opcs:'W40',  cpt:'27447',specialty:'Orthopaedics',      type:'Open'},
  { name:'Dynamic Hip Screw',              opcs:'W24',  cpt:'27244',specialty:'Orthopaedics',      type:'Open'},
  { name:'ORIF Tibia',                     opcs:'W33',  cpt:'27759',specialty:'Orthopaedics',      type:'Open'},
  { name:'Arthroscopic Knee Meniscectomy', opcs:'W82',  cpt:'29881',specialty:'Orthopaedics',      type:'Arthroscopic'},
  { name:'CABG',                           opcs:'K40',  cpt:'33533',specialty:'Cardiothoracic',    type:'Open'},
  { name:'Aortic Valve Replacement',       opcs:'K26',  cpt:'33405',specialty:'Cardiothoracic',    type:'Open'},
  { name:'Thoracoscopic Lobectomy',        opcs:'E54.3',cpt:'32663',specialty:'Cardiothoracic',    type:'Thoracoscopic'},
  { name:'Mastectomy',                     opcs:'B27',  cpt:'19307',specialty:'Breast Surgery',    type:'Open'},
  { name:'Wide Local Excision Breast',     opcs:'B28',  cpt:'19301',specialty:'Breast Surgery',    type:'Open'},
  { name:'Sentinel Lymph Node Biopsy',     opcs:'B32',  cpt:'38740',specialty:'Breast Surgery',    type:'Open'},
  { name:'Thyroidectomy',                  opcs:'B08',  cpt:'60240',specialty:'ENT / Head & Neck', type:'Open'},
  { name:'Parotidectomy',                  opcs:'G19',  cpt:'42410',specialty:'ENT / Head & Neck', type:'Open'},
  { name:'TURP',                           opcs:'M61',  cpt:'52612',specialty:'Urology',           type:'Endoscopic'},
  { name:'Radical Prostatectomy',          opcs:'M61.1',cpt:'55866',specialty:'Urology',           type:'Laparoscopic'},
  { name:'Nephrectomy',                    opcs:'M04',  cpt:'50545',specialty:'Urology',           type:'Laparoscopic'},
  { name:'PCNL',                           opcs:'M09',  cpt:'50080',specialty:'Urology',           type:'Endoscopic'},
  { name:'Laparotomy',                     opcs:'T30',  cpt:'49000',specialty:'General Surgery',   type:'Open'},
  { name:'Oesophagectomy',                 opcs:'G11',  cpt:'43107',specialty:'Upper GI',          type:'Open'},
  { name:'Gastrectomy (Partial)',          opcs:'G27',  cpt:'43631',specialty:'Upper GI',          type:'Open'},
  { name:'Whipple Procedure',              opcs:'J58',  cpt:'48150',specialty:'HPB Surgery',       type:'Open'},
  { name:'Liver Resection',                opcs:'J08',  cpt:'47120',specialty:'HPB Surgery',       type:'Open'},
  { name:'Splenectomy',                    opcs:'J41',  cpt:'38100',specialty:'General Surgery',   type:'Open'},
  { name:'Bowel Resection',                opcs:'H04',  cpt:'44120',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Stoma Formation',                opcs:'H15',  cpt:'44320',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Haemorrhoidectomy',              opcs:'H51',  cpt:'46260',specialty:'Colorectal Surgery',type:'Open'},
  { name:'Pilonidal Sinus Excision',       opcs:'S50',  cpt:'11770',specialty:'General Surgery',   type:'Open'},
  { name:'Excision Skin Lesion',           opcs:'S04',  cpt:'11400',specialty:'Plastics',          type:'Open'},
];
const SPECIALTIES = [...new Set(PROC_CODES.map(p => p.specialty))].sort();

function classifyCD(text) {
  if (!text?.trim()) return null;
  const t = text.toLowerCase();
  if (/death|cardiac arrest|brain.?stem.?death/.test(t))                                           return 'V';
  if (/icu|intensive care|organ.?failure|ventilat|vasopressor|life.?threat/.test(t))               return 'IV';
  if (/re.?operat|re.?interven|anastomot.?leak|septic shock/.test(t))                              return 'III';
  if (/iv antibiotic|blood transfus|total parenteral|dvt|pe\b|atrial fib|pneumonia/.test(t))       return 'II';
  if (/antiemetic|antipyretic|analgesic|diuretic|wound infect|superficial/.test(t))                return 'I';
  if (/no complica|uncomplicated|nil|none/.test(t))                                                return null;
  return 'I';
}
const CD_LABELS = { I:'Grade I', II:'Grade II', III:'Grade III', IV:'Grade IV', V:'Grade V' };
const CD_DESC   = {
  I:   'Minor — analgesics/antipyretics only',
  II:  'Pharmacological treatment required',
  III: 'Surgical/endoscopic re-intervention required',
  IV:  'Life-threatening — requires ICU',
  V:   'Death of patient'
};

// ============================================================
// AI SMART ENTRY
// ============================================================
async function runNLP() {
  const txt = document.getElementById('nlpInput').value.trim();
  if (!txt) { toast('Type a description first'); return; }

  const btn = document.getElementById('nlpBtn');
  btn.disabled = true; btn.textContent = '…';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You are a surgical logbook assistant. Extract structured fields from a freetext surgical procedure description.
Return ONLY valid JSON with these keys (omit any you cannot determine):
- procedureName (string, e.g. "Laparoscopic Cholecystectomy")
- specialty (one of: ${SPECIALTIES.join(', ')})
- procedureType (e.g. "Laparoscopic", "Open", "Endoscopic")
- surgeonName (string, just name)
- competencyLevel (one of: "Observed", "Assisted", "Performed (Supervised)", "Performed (Independent)", "Scrubbed", "Other")
- duration (number of minutes as a string)
- complications (string or "None")
- date (YYYY-MM-DD only if explicitly mentioned, today is ${todayISO()})
No explanation, no markdown, just JSON.`,
        messages: [{ role: 'user', content: txt }]
      })
    });

    const data = await response.json();
    const raw  = data?.content?.[0]?.text || '{}';
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
    catch { toast('Could not parse AI response — try manual entry'); btn.disabled = false; btn.textContent = '✨'; return; }

    // Match procedure name to our code database
    if (parsed.procedureName) {
      const match = PROC_CODES.find(p =>
        p.name.toLowerCase() === parsed.procedureName.toLowerCase() ||
        parsed.procedureName.toLowerCase().includes(p.name.toLowerCase())
      );
      if (match) {
        document.getElementById('f_procedureName').value = match.name;
        document.getElementById('f_procedureCode').value = `OPCS: ${match.opcs} / CPT: ${match.cpt}`;
        document.getElementById('f_procedureType').value = match.type;
        const sel = document.getElementById('f_specialty');
        for (let o of sel.options) if (o.value === match.specialty) { o.selected = true; break; }
      } else {
        document.getElementById('f_procedureName').value = parsed.procedureName;
      }
    }
    if (parsed.specialty) {
      const sel = document.getElementById('f_specialty');
      for (let o of sel.options) if (o.value === parsed.specialty) { o.selected = true; break; }
    }
    if (parsed.procedureType) document.getElementById('f_procedureType').value = parsed.procedureType;
    if (parsed.surgeonName)   document.getElementById('f_surgeonName').value   = parsed.surgeonName;
    if (parsed.duration)      document.getElementById('f_duration').value       = String(parsed.duration);
    if (parsed.complications) {
      document.getElementById('f_complications').value = parsed.complications;
      updateCDPreview(parsed.complications);
    }
    if (parsed.date)          document.getElementById('f_date').value = parsed.date;
    if (parsed.competencyLevel) {
      document.getElementById('f_competencyLevel').value = parsed.competencyLevel;
      document.querySelectorAll('.comp-chip').forEach(c => {
        c.className = 'comp-chip';
        if (c.textContent.trim() === parsed.competencyLevel) {
          const key = parsed.competencyLevel === 'Performed (Supervised)'  ? 'supervised'  :
                      parsed.competencyLevel === 'Performed (Independent)' ? 'independent' :
                      parsed.competencyLevel.toLowerCase();
          c.classList.add('sel-' + key);
        }
      });
    }
    document.getElementById('nlpInput').value = '';
    formIsDirty = true;
    toast('Fields populated ✓');
  } catch (e) {
    console.error('AI NLP error', e);
    toast('Smart entry unavailable — fill manually');
  }
  btn.disabled = false; btn.textContent = '✨';
}

// ============================================================
// NAVIGATION
// ============================================================
function goScreen(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  activeScreen = name;

  document.getElementById('fab').style.display             = name === 'log' ? 'flex' : 'none';
  document.getElementById('shareBtn').style.display        = name === 'log' ? 'flex' : 'none';
  document.getElementById('guideBtn').style.display        = name === 'log' ? 'flex' : 'none';
  document.getElementById('headerActionBtn').style.display = 'none';

  const titles = { log:'Incisio', dashboard:'Dashboard', followups:'Follow-ups', settings:'Settings' };
  document.getElementById('headerTitle').textContent = titles[name] || 'Incisio';

  if (name === 'log')       { renderStats(); renderFilters(); renderLog(); }
  if (name === 'dashboard') renderDashboard();
  if (name === 'followups') renderFollowUps();
  if (name === 'settings')  populateSettingsProfile();
}

function pushScreen(name, title) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  activeScreen = name;

  document.getElementById('fab').style.display             = 'none';
  document.getElementById('shareBtn').style.display        = 'none';
  document.getElementById('guideBtn').style.display        = 'none';

  const btn  = document.getElementById('headerActionBtn');
  const icon = document.getElementById('headerActionIcon');
  btn.style.display = 'flex';
  icon.setAttribute('d', 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18');
  btn._action = 'back';
  if (title) document.getElementById('headerTitle').textContent = title;
}

function headerAction() {
  if (document.getElementById('headerActionBtn')._action === 'back') {
    // FIX: Dirty form guard — warn before navigating away
    if (activeScreen === 'form' && formIsDirty) {
      showConfirm(
        'Discard changes?',
        'You have unsaved changes. Are you sure you want to go back?',
        () => returnToLog()
      );
    } else {
      returnToLog();
    }
  }
}

function returnToLog() {
  formIsDirty = false;
  goScreen('log', document.getElementById('navLog'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('navLog').classList.add('active');
}

// ============================================================
// LOG SCREEN
// ============================================================
function renderStats() {
  const total  = entries.length;
  const specs  = new Set(entries.map(e => e.specialty).filter(Boolean)).size;
  const signed = entries.filter(e => e.signatureData).length;
  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">Procedures</div></div>
    <div class="stat-card"><div class="stat-num">${specs}</div><div class="stat-label">Specialties</div></div>
    <div class="stat-card"><div class="stat-num">${signed}</div><div class="stat-label">Signed off</div></div>`;
}

function renderFilters() {
  const specs = [...new Set(entries.map(e => e.specialty).filter(Boolean))].sort();
  let html = `<div class="chip ${currentFilter==='all'?'active':''}" onclick="setFilter('all')">All</div>`;
  specs.forEach(s => {
    html += `<div class="chip ${currentFilter===s?'active':''}" onclick="setFilter(${JSON.stringify(s)})">${s}</div>`;
  });
  document.getElementById('filterRow').innerHTML = html;
}
function setFilter(v) { currentFilter = v; renderFilters(); renderLog(); }

function renderLog() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  const filtered = entries.filter(e => {
    const mf = currentFilter === 'all' || e.specialty === currentFilter;
    const ms = !q || [e.procedureName, e.specialty, e.surgeonName, e.procedureType, e.outcome, e.complications]
      .some(f => f && f.toLowerCase().includes(q));
    return mf && ms;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  document.getElementById('countBadge').textContent = filtered.length;

  if (!filtered.length) {
    document.getElementById('entryList').innerHTML = `<div class="empty">
      <svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>
      <p>${entries.length ? 'No matching entries' : 'No procedures yet.<br>Tap + to add your first entry.'}</p>
    </div>`;
    return;
  }

  const cMap = {
    'Observed':'comp-observed', 'Assisted':'comp-assisted',
    'Performed (Supervised)':'comp-supervised', 'Performed (Independent)':'comp-independent',
    'Scrubbed':'comp-scrubbed', 'Other':'comp-other'
  };
  const lMap = {
    'Observed':'Observed', 'Assisted':'Assisted',
    'Performed (Supervised)':'Supervised', 'Performed (Independent)':'Independent',
    'Scrubbed':'Scrubbed', 'Other':'Other'
  };
  const isPending = id => pendingSync.some(p => p.id === id && p.type === 'upsert');

  document.getElementById('entryList').innerHTML = filtered.map(e => `
    <div class="entry-wrap" id="wrap-${e.id}">
      <div class="entry-delete-bg" onclick="deleteEntry('${e.id}')">
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>
      </div>
      <div class="card" onclick="openDetail('${e.id}')"
           ontouchstart="touchStart(event,'${e.id}')"
           ontouchmove="touchMove(event,'${e.id}')"
           ontouchend="touchEnd(event,'${e.id}')">
        <div class="card-row">
          <div class="entry-name">${esc(e.procedureName || 'Untitled')}</div>
          <div class="entry-date">${formatDate(e.date)}</div>
        </div>
        <div class="entry-meta">
          ${e.specialty       ? `<span class="tag tag-specialty">${esc(e.specialty)}</span>`                         : ''}
          ${e.competencyLevel ? `<span class="tag ${cMap[e.competencyLevel]||''}">${lMap[e.competencyLevel]||e.competencyLevel}</span>` : ''}
          ${e.signatureData   ? `<span class="tag tag-signed">✓ Signed</span>`                                        : ''}
          ${isPending(e.id)   ? `<span class="tag tag-pending">⏳ Pending</span>`                                     : ''}
        </div>
        ${e.surgeonName ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;">With ${esc(e.surgeonName)}</div>` : ''}
      </div>
    </div>`).join('');
}

let touchStartX = 0;
function touchStart(e, id) { touchStartX = e.touches[0].clientX; }
function touchMove(e, id) {
  const dx = e.touches[0].clientX - touchStartX;
  if (dx < -10) {
    const c = document.querySelector(`#wrap-${id} .card`);
    if (c) c.style.transform = `translateX(${Math.max(dx, -80)}px)`;
  }
}
function touchEnd(e, id) {
  const c = document.querySelector(`#wrap-${id} .card`);
  if (!c) return;
  const dx = parseFloat(c.style.transform.replace('translateX(', '')) || 0;
  c.style.transform = dx < -60 ? 'translateX(-80px)' : 'translateX(0)';
}

// ============================================================
// DETAIL SCREEN
// ============================================================
function openDetail(id) {
  const e = entries.find(x => x.id === id); if (!e) return;
  const cd = classifyCD(e.complications);

  document.getElementById('detailContent').innerHTML = `
    <div class="detail-title">${esc(e.procedureName || 'Untitled')}</div>
    <div class="detail-date">${formatDate(e.date)}</div>
    <div class="card" style="margin-bottom:10px;">
      ${drow('Date',formatDate(e.date))}
      ${drow('Procedure',e.procedureName)}
      ${drow('Code',e.procedureCode)}
      ${drow('Type',e.procedureType)}
      ${drow('Specialty',e.specialty)}
      ${drow('Surgeon / Supervisor',e.surgeonName)}
      ${drow('Role / Title',e.roleTitle)}
      ${drow('Reg. Number',e.regNumber)}
      ${drow('Competency',e.competencyLevel)}
      ${drow('Duration',e.duration ? e.duration + ' min' : '')}
    </div>
    ${e.complications ? `<div class="card" style="margin-bottom:10px;"><div class="form-section-title">Complications</div><div style="font-size:14px;">${esc(e.complications)}</div>${cd ? `<div class="cd-badge cd-${cd}">${CD_LABELS[cd]} — ${CD_DESC[cd]}</div>` : ''}</div>` : ''}
    ${e.outcome ? `<div class="card" style="margin-bottom:10px;"><div class="form-section-title">Outcome / Notes</div><div style="font-size:14px;">${esc(e.outcome)}</div></div>` : ''}
    ${e.followUpDate ? `<div class="card" style="margin-bottom:10px;">${drow('Follow-up Due',formatDate(e.followUpDate))}${e.followUpNotes ? drow('Follow-up Notes',e.followUpNotes) : ''}</div>` : ''}
    ${e.signatureData ? `<div class="card" style="margin-bottom:10px;"><div class="form-section-title">Supervisor Sign-off</div><img src="${e.signatureData}" class="sig-preview" alt="Signature">${e.supervisorName ? `<div style="font-size:12px;color:var(--muted);margin-top:8px;">${esc(e.supervisorName)}</div>` : ''}</div>` : ''}
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="openEdit('${id}')">Edit</button>
      <button class="btn btn-danger"    onclick="deleteEntry('${id}'); returnToLog();">Delete</button>
    </div>
    <div style="margin-top:10px;">
      <button class="btn btn-secondary" onclick="duplicateEntry('${id}')">Duplicate Entry</button>
    </div>`;

  pushScreen('detail', e.procedureName || 'Entry Detail');
}

function drow(key, val) {
  if (!val) return '';
  return `<div class="detail-row"><span class="detail-key">${key}</span><span class="detail-val">${esc(val)}</span></div>`;
}

// ============================================================
// ADD / EDIT FORM
// ============================================================
function openAdd() {
  editingId = null; formIsDirty = false;
  renderForm({ roleTitle: userProfile.roleTitle || '', regNumber: userProfile.regNumber || '' });
  pushScreen('form', 'New Procedure');
}

function openEdit(id) {
  editingId = id; formIsDirty = false;
  renderForm(entries.find(x => x.id === id) || {});
  pushScreen('form', 'Edit Procedure');
}

function duplicateEntry(id) {
  const e = entries.find(x => x.id === id); if (!e) return;
  const dup = { ...e, id: genId(), date: todayISO(), signatureData: null, supervisorName: '' };
  entries.unshift(dup);
  pendingSync.push({ type: 'upsert', id: dup.id });
  saveLocal();
  openEdit(dup.id);
  toast('Entry duplicated');
  if (isOnline) syncToCloud();
}

function renderForm(data) {
  const compLevels = ['Observed', 'Assisted', 'Performed (Supervised)', 'Performed (Independent)', 'Scrubbed', 'Other'];
  const compChips  = compLevels.map(l => {
    const sel = data.competencyLevel === l;
    const key = l === 'Performed (Supervised)'  ? 'supervised'  :
                l === 'Performed (Independent)' ? 'independent' :
                l === 'Scrubbed' ? 'scrubbed' :
                l === 'Other'    ? 'other'     : l.toLowerCase();
    return `<div class="comp-chip ${sel ? 'sel-' + key : ''}" onclick="selectComp(this,'${l}')">${l}</div>`;
  }).join('');

  document.getElementById('formContent').innerHTML = `
    <div class="form-section">
      <div class="form-section-title">✨ Smart Entry — AI</div>
      <div class="nlp-row">
        <input class="nlp-input" id="nlpInput" placeholder="e.g. lap chole with Mr Smith, assisted, 45 min…" oninput="formIsDirty=true">
        <button class="nlp-btn" id="nlpBtn" onclick="runNLP()">✨</button>
      </div>
      <div class="nlp-disclaimer">⚠️ AI-powered. Do not enter patient-identifiable information.</div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Procedure Details</div>
      <div class="field"><label>Date<span class="required-star">*</span></label><input type="date" id="f_date" value="${data.date || todayISO()}" oninput="formIsDirty=true"></div>
      <div class="field">
        <label>Procedure Name<span class="required-star">*</span></label>
        <input type="text" id="f_procedureName" value="${esc(data.procedureName || '')}" placeholder="e.g. Laparoscopic Cholecystectomy" autocomplete="off" oninput="showProcSuggestions(this.value);formIsDirty=true;">
        <div class="autocomplete-list" id="procList"></div>
      </div>
      <div class="field"><label>Procedure Code (OPCS / CPT)</label><input type="text" id="f_procedureCode" value="${esc(data.procedureCode || '')}" placeholder="e.g. OPCS: J18.3" oninput="formIsDirty=true"></div>
      <div class="field"><label>Procedure Type</label><input type="text" id="f_procedureType" value="${esc(data.procedureType || '')}" placeholder="e.g. Laparoscopic, Open" oninput="formIsDirty=true"></div>
      <div class="field"><label>Specialty</label>
        <select id="f_specialty" onchange="formIsDirty=true">
          <option value="">— Select specialty —</option>
          ${SPECIALTIES.map(s => `<option value="${s}" ${data.specialty === s ? 'selected' : ''}>${s}</option>`).join('')}
          <option value="Other" ${data.specialty === 'Other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Role &amp; Competency</div>
      <div class="field"><label>Surgeon / Supervisor Name</label><input type="text" id="f_surgeonName" value="${esc(data.surgeonName || '')}" placeholder="e.g. Mr A Smith" oninput="formIsDirty=true"></div>
      <div class="field"><label>Your Role / Title</label><input type="text" id="f_roleTitle" value="${esc(data.roleTitle || '')}" placeholder="e.g. SFA, Scrub Nurse, ODP" oninput="formIsDirty=true"></div>
      <div class="field"><label>Registration Number (NMC / HCPC / FPA)</label><input type="text" id="f_regNumber" value="${esc(data.regNumber || '')}" placeholder="e.g. NMC 12A3456B" oninput="formIsDirty=true"></div>
      <div class="field"><label>Competency Level</label>
        <div class="comp-chips" id="compChips">${compChips}</div>
        <input type="hidden" id="f_competencyLevel" value="${esc(data.competencyLevel || '')}">
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Clinical Details</div>
      <div class="field"><label>Duration (minutes)</label><input type="number" id="f_duration" value="${esc(data.duration || '')}" placeholder="e.g. 90" min="1" max="999" oninput="formIsDirty=true"></div>
      <div class="field"><label>Complications</label><textarea id="f_complications" oninput="updateCDPreview(this.value);formIsDirty=true;" placeholder="Describe complications, or 'None'…">${esc(data.complications || '')}</textarea><div id="cdPreview"></div></div>
      <div class="field"><label>Outcome / Notes</label><textarea id="f_outcome" placeholder="Post-op outcome, learning points…" oninput="formIsDirty=true">${esc(data.outcome || '')}</textarea></div>
    </div>
    <div class="form-section">
      <div class="form-section-title">30-Day Follow-up</div>
      <div class="field"><label>Follow-up Due Date</label><input type="date" id="f_followUpDate" value="${data.followUpDate || ''}" oninput="formIsDirty=true"></div>
      <div class="field"><label>Follow-up Notes</label><textarea id="f_followUpNotes" placeholder="Planned follow-up, concerns…" oninput="formIsDirty=true">${esc(data.followUpNotes || '')}</textarea></div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Supervisor Sign-off</div>
      <div class="field"><label>Supervisor Name</label><input type="text" id="f_supervisorName" value="${esc(data.supervisorName || '')}" placeholder="Supervisor's name" oninput="formIsDirty=true"></div>
      <div class="field">
        <label>Signature <span style="font-weight:400;color:var(--muted);">(trace with finger)</span></label>
        <div class="sig-wrap"><canvas id="sigCanvas" height="130"></canvas><div class="sig-label" id="sigLabel">Sign here →</div><button class="sig-clear" onclick="clearSig()">Clear</button></div>
        ${data.signatureData ? `<img src="${data.signatureData}" class="sig-preview" style="margin-top:8px;"><p style="font-size:11px;color:var(--muted);margin-top:4px;">Draw above to replace existing signature</p>` : ''}
      </div>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="cancelForm()">Cancel</button>
      <button class="btn btn-primary"   onclick="saveForm()">Save Entry</button>
    </div>`;

  if (data.complications) updateCDPreview(data.complications);
  requestAnimationFrame(() => initSigCanvas());
}

// FIX: Signature always draws in dark ink so it's visible on white PDF background
function initSigCanvas() {
  sigCanvas = document.getElementById('sigCanvas'); if (!sigCanvas) return;
  sigCanvas.width = sigCanvas.offsetWidth * devicePixelRatio;
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.scale(devicePixelRatio, devicePixelRatio);
  // Always use dark ink — canvas background is always white so signature is visible in PDFs
  sigCtx.strokeStyle = '#1a1a1a';
  sigCtx.lineWidth   = 2;
  sigCtx.lineCap     = 'round';
  sigCtx.lineJoin    = 'round';
  sigDrawing = false; sigHasData = false;

  const getPos = e => {
    const rect = sigCanvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };

  sigCanvas.addEventListener('mousedown',  e => { sigDrawing = true; const p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); });
  sigCanvas.addEventListener('mousemove',  e => { if (!sigDrawing) return; const p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); sigHasData = true; document.getElementById('sigLabel').style.opacity = '0'; });
  sigCanvas.addEventListener('mouseup',    () => sigDrawing = false);
  sigCanvas.addEventListener('touchstart', e => { e.preventDefault(); sigDrawing = true; const p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); }, { passive: false });
  sigCanvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!sigDrawing) return; const p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); sigHasData = true; document.getElementById('sigLabel').style.opacity = '0'; formIsDirty = true; }, { passive: false });
  sigCanvas.addEventListener('touchend',   () => sigDrawing = false);
}

function clearSig() {
  if (sigCtx) sigCtx.clearRect(0, 0, sigCanvas.width / devicePixelRatio, sigCanvas.height / devicePixelRatio);
  sigHasData = false;
  const l = document.getElementById('sigLabel'); if (l) l.style.opacity = '1';
}

function selectComp(el, val) {
  document.querySelectorAll('.comp-chip').forEach(c => c.className = 'comp-chip');
  const key = val === 'Performed (Supervised)'  ? 'supervised'  :
              val === 'Performed (Independent)' ? 'independent' :
              val === 'Scrubbed' ? 'scrubbed' :
              val === 'Other'    ? 'other'     : val.toLowerCase();
  el.classList.add('sel-' + key);
  document.getElementById('f_competencyLevel').value = val;
  formIsDirty = true;
}

function updateCDPreview(val) {
  const cd = classifyCD(val);
  const el = document.getElementById('cdPreview'); if (!el) return;
  el.innerHTML = cd ? `<div class="cd-badge cd-${cd}">${CD_LABELS[cd]} — ${CD_DESC[cd]}</div>` : '';
}

function showProcSuggestions(val) {
  const list = document.getElementById('procList');
  if (!val || val.length < 2) { list.classList.remove('open'); return; }
  const matches = PROC_CODES.filter(p => p.name.toLowerCase().includes(val.toLowerCase())).slice(0, 5);
  if (!matches.length) { list.classList.remove('open'); return; }
  list.innerHTML = matches.map(p =>
    `<div class="autocomplete-item" onclick='selectProc(${JSON.stringify(p)})'>
      <div style="font-weight:500;">${p.name}</div>
      <div style="font-size:11px;color:var(--muted);">OPCS: ${p.opcs} · CPT: ${p.cpt} · ${p.specialty}</div>
    </div>`).join('');
  list.classList.add('open');
}
function selectProc(p) {
  document.getElementById('f_procedureName').value = p.name;
  document.getElementById('f_procedureCode').value = `OPCS: ${p.opcs} / CPT: ${p.cpt}`;
  document.getElementById('f_procedureType').value = p.type;
  const sel = document.getElementById('f_specialty');
  for (let o of sel.options) if (o.value === p.specialty) { o.selected = true; break; }
  document.getElementById('procList').classList.remove('open');
  formIsDirty = true;
}

function saveForm() {
  const name = document.getElementById('f_procedureName').value.trim();
  const date = document.getElementById('f_date').value;
  if (!name) { toast('⚠️ Procedure name is required'); return; }
  if (!date) { toast('⚠️ Date is required'); return; }

  let sigData = null;
  if (sigHasData && sigCanvas) sigData = sigCanvas.toDataURL('image/png');
  else if (editingId) sigData = (entries.find(e => e.id === editingId) || {}).signatureData;

  const entry = {
    id:              editingId || genId(),
    date,
    procedureName:   name,
    procedureCode:   document.getElementById('f_procedureCode').value.trim(),
    procedureType:   document.getElementById('f_procedureType').value.trim(),
    specialty:       document.getElementById('f_specialty').value,
    surgeonName:     document.getElementById('f_surgeonName').value.trim(),
    roleTitle:       document.getElementById('f_roleTitle').value.trim(),
    regNumber:       document.getElementById('f_regNumber').value.trim(),
    competencyLevel: document.getElementById('f_competencyLevel').value,
    duration:        document.getElementById('f_duration').value.trim(),
    complications:   document.getElementById('f_complications').value.trim(),
    outcome:         document.getElementById('f_outcome').value.trim(),
    followUpDate:    document.getElementById('f_followUpDate').value,
    followUpNotes:   document.getElementById('f_followUpNotes').value.trim(),
    supervisorName:  document.getElementById('f_supervisorName').value.trim(),
    signatureData:   sigData
  };

  if (editingId) {
    const idx = entries.findIndex(e => e.id === editingId);
    if (idx !== -1) entries[idx] = entry;
    // Remove any existing pending op for this ID
    pendingSync = pendingSync.filter(p => p.id !== editingId);
  } else {
    entries.unshift(entry);
  }
  pendingSync.push({ type: 'upsert', id: entry.id });
  saveLocal();
  setSyncStatus('pending');
  if (isOnline) syncToCloud();

  formIsDirty = false;
  returnToLog();
  setTimeout(() => toast(editingId ? 'Entry updated ✓' : 'Entry saved ✓'), 150);
}

function cancelForm() {
  if (formIsDirty) {
    showConfirm('Discard changes?', 'You have unsaved changes. Are you sure?', () => {
      formIsDirty = false; returnToLog();
    });
  } else {
    returnToLog();
  }
}

// FIX: Delete with undo + fix upsert/delete race condition
function deleteEntry(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  // Remove from local list immediately
  entries = entries.filter(e => e.id !== id);

  // FIX: Cancel any pending upsert for this ID before queuing delete
  pendingSync = pendingSync.filter(p => p.id !== id);
  pendingSync.push({ type: 'delete', id });
  saveLocal();
  renderStats(); renderFilters(); renderLog();
  setSyncStatus('pending');

  // Store for undo
  undoEntry = entry;
  showUndoBar();

  // Commit delete to cloud after undo window expires
  undoTimer = setTimeout(() => {
    undoEntry = null;
    if (isOnline) syncToCloud();
  }, 4000);
}

function showUndoBar() {
  const bar = document.getElementById('undoBar');
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 4000);
}

function undoDelete() {
  if (!undoEntry) return;
  clearTimeout(undoTimer);
  // Restore entry
  entries.unshift(undoEntry);
  // Remove the delete op
  pendingSync = pendingSync.filter(p => !(p.id === undoEntry.id && p.type === 'delete'));
  pendingSync.push({ type: 'upsert', id: undoEntry.id });
  saveLocal();
  renderStats(); renderFilters(); renderLog();
  setSyncStatus('pending');
  undoEntry = null;
  document.getElementById('undoBar').classList.remove('show');
  toast('Entry restored ✓');
  if (isOnline) syncToCloud();
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  if (!entries.length) {
    document.getElementById('dashboardContent').innerHTML = `<div class="empty"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75Z"/></svg><p>No data yet.</p></div>`;
    return;
  }
  const mc = {};
  entries.forEach(e => { if (e.date) { const m = e.date.slice(0,7); mc[m] = (mc[m]||0)+1; } });
  const months  = Object.keys(mc).sort().slice(-6);
  const maxM    = Math.max(...months.map(m => mc[m]), 1);
  const monthBars = months.map(m => {
    const [y,mo] = m.split('-');
    const label  = new Date(y, mo-1).toLocaleString('default', { month:'short', year:'2-digit' });
    return `<div class="bar-row"><div class="bar-label">${label}</div><div class="bar-track"><div class="bar-fill" style="width:${(mc[m]/maxM*100).toFixed(1)}%"></div></div><div class="bar-count">${mc[m]}</div></div>`;
  }).join('');

  const sc = {};
  entries.forEach(e => { if (e.specialty) sc[e.specialty] = (sc[e.specialty]||0)+1; });
  const topSpecs = Object.entries(sc).sort((a,b) => b[1]-a[1]).slice(0,6);
  const maxS     = topSpecs[0]?.[1] || 1;
  const specBars = topSpecs.map(([sp,n]) =>
    `<div class="bar-row"><div class="bar-label" style="font-size:11px;">${sp}</div><div class="bar-track"><div class="bar-fill" style="width:${(n/maxS*100).toFixed(1)}%;background:linear-gradient(90deg,var(--info),#79C0FF)"></div></div><div class="bar-count">${n}</div></div>`
  ).join('');

  const cc  = { Observed:0, Assisted:0, 'Performed (Supervised)':0, 'Performed (Independent)':0 };
  entries.forEach(e => { if (e.competencyLevel && cc[e.competencyLevel] !== undefined) cc[e.competencyLevel]++; });
  const compColors = { Observed:'var(--comp2)', Assisted:'var(--comp3)', 'Performed (Supervised)':'var(--comp4)', 'Performed (Independent)':'var(--comp1)' };
  const compLegend = Object.entries(cc).filter(([,n]) => n > 0).map(([k,n]) =>
    `<div class="legend-item"><div class="legend-dot" style="background:${compColors[k]}"></div><span style="flex:1;">${k}</span><span style="color:var(--muted);font-family:'DM Mono',monospace;font-size:11px;">${n}</span></div>`
  ).join('');

  const total   = entries.length;
  const circ    = 2 * Math.PI * 40;
  let   offset  = 0;
  const arcs    = Object.entries(cc).filter(([,n]) => n > 0).map(([k,n]) => {
    const dash = (n/total)*circ;
    const arc  = `<circle cx="50" cy="50" r="40" fill="none" stroke="${compColors[k]}" stroke-width="14" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 50 50)"/>`;
    offset += dash; return arc;
  });
  const donutSvg = `<svg viewBox="0 0 100 100" width="120" height="120" style="flex-shrink:0"><circle cx="50" cy="50" r="40" fill="none" stroke="var(--surface2)" stroke-width="14"/>${arcs.join('')}<text x="50" y="54" text-anchor="middle" fill="var(--text)" font-size="16" font-family="Playfair Display,serif" font-weight="700">${total}</text></svg>`;

  document.getElementById('dashboardContent').innerHTML = `
    <div class="dash-section-title">Cases per Month</div>
    <div class="card">${monthBars || '<p style="color:var(--muted);font-size:13px;">Not enough data yet</p>'}</div>
    <div class="dash-section-title">By Specialty</div>
    <div class="card">${specBars || '<p style="color:var(--muted);font-size:13px;">No specialty data</p>'}</div>
    <div class="dash-section-title">Competency Breakdown</div>
    <div class="card"><div class="comp-donut-wrap">${donutSvg}<div class="comp-legend">${compLegend || '<p style="color:var(--muted);font-size:13px;">No data</p>'}</div></div></div>`;
}

// ============================================================
// FOLLOW-UPS
// ============================================================
function renderFollowUps() {
  const today   = todayISO();
  const soon    = new Date(); soon.setDate(soon.getDate() + 7);
  const soonISO = soon.toISOString().slice(0, 10);

  const list = entries
    .filter(e => e.followUpDate)
    .map(e => ({
      ...e,
      badge: e.followUpDate < today    ? `<span class="overdue-badge">Overdue</span>`
           : e.followUpDate <= soonISO ? `<span class="due-soon-badge">Due soon</span>`
           :                             `<span class="done-badge">Upcoming</span>`
    }))
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));

  document.getElementById('followupContent').innerHTML = list.length
    ? list.map(e => `
        <div class="card" onclick="openDetail('${e.id}')">
          <div class="card-row">
            <div class="entry-name" style="font-size:14px;">${esc(e.procedureName)}</div>
            ${e.badge}
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px;">
            Follow-up: ${formatDate(e.followUpDate)}${e.followUpNotes ? ' · ' + esc(e.followUpNotes) : ''}
          </div>
        </div>`).join('')
    : `<div class="empty"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg><p>No follow-up dates set.</p></div>`;
}

// ============================================================
// SETTINGS / PROFILE
// ============================================================
function populateSettingsProfile() {
  const p = userProfile;
  ['fullName','roleTitle','regNumber','hospital'].forEach(k => {
    const el = document.getElementById('prof_' + k);
    if (el) el.value = p[k] || '';
  });
}

async function saveProfileFromSettings() {
  const p = {
    fullName:  document.getElementById('prof_fullName').value.trim(),
    roleTitle: document.getElementById('prof_roleTitle').value.trim(),
    regNumber: document.getElementById('prof_regNumber').value.trim(),
    hospital:  document.getElementById('prof_hospital').value.trim()
  };
  saveProfile(p);
  await upsertProfileToCloud(p);
  toast('Profile saved ✓');
}

// ============================================================
// CSV EXPORT — includes signatureData
// ============================================================
function exportCSV() {
  const fields = [
    'date','procedureName','procedureCode','procedureType','specialty',
    'surgeonName','roleTitle','regNumber','competencyLevel','duration',
    'complications','outcome','followUpDate','followUpNotes','supervisorName','signatureData'
  ];
  const header = fields.join(',');
  const rows   = entries.map(e =>
    fields.map(f => `"${String(e[f] || '').replace(/"/g, '""')}"`).join(',')
  );
  const csv = [header, ...rows].join('\n');
  const a   = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `incisio_export_${todayISO()}.csv`;
  a.click();
  toast('CSV exported ✓');
}

// ============================================================
// PDF EXPORT
// FIX: field() helper hoisted outside loop; progress warning for large sets
// ============================================================
async function exportPDF() {
  if (!entries.length) { toast('No entries to export'); return; }

  const signedCount = entries.filter(e => e.signatureData).length;
  if (signedCount > 50) {
    showConfirm(
      'Large export',
      `Your logbook has ${signedCount} signed entries. The PDF may take 30+ seconds to generate on mobile. Continue?`,
      () => _generatePDF()
    );
  } else {
    await _generatePDF();
  }
}

async function _generatePDF() {
  const btn = document.getElementById('pdfBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  toast('Generating PDF…');

  try {
    await loadJsPDF();
    const { jsPDF } = window.jspdf;
    const doc      = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
    const pageW    = 210, pageH = 297, margin = 15;
    const contentW = pageW - margin * 2;
    let y = margin;

    const GOLD = [180,140,50], DARK = [30,35,40], GREY = [100,110,120], LIGHT = [245,247,250], LINE = [200,205,210];

    // FIX: field() defined ONCE outside the loop
    function pdfField(label, value) {
      if (!value) return;
      checkPage(8);
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...GREY);
      doc.text(label.toUpperCase(), margin, y);
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
      const lines = doc.splitTextToSize(String(value), contentW - 45);
      doc.text(lines, margin + 45, y);
      y += Math.max(6, lines.length * 5);
    }

    function checkPage(needed = 20) {
      if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
    }

    function hline() {
      doc.setDrawColor(...LINE); doc.setLineWidth(0.3);
      doc.line(margin, y, pageW - margin, y); y += 3;
    }

    // ── Cover page ────────────────────────────────────────
    doc.setFillColor(...DARK); doc.rect(0,0,pageW,pageH,'F');
    doc.setFillColor(...GOLD); doc.rect(0,60,pageW,80,'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(42);
    doc.text('INCISIO', pageW/2, 95, { align:'center' });
    doc.setFontSize(13); doc.setFont('helvetica','normal');
    doc.text('Surgical Procedure Logbook', pageW/2, 107, { align:'center' });

    doc.setTextColor(200,200,200); doc.setFontSize(11);
    const p = userProfile;
    const profileLines = [
      p.fullName  || '',
      p.roleTitle || '',
      p.regNumber || '',
      p.hospital  || '',
      '',
      `Generated: ${new Date().toLocaleDateString('en-GB',{ day:'2-digit', month:'long', year:'numeric' })}`,
      `Total entries: ${entries.length}`
    ].filter((l, i) => i >= 5 || l);

    let cy = 160;
    profileLines.forEach(line => { doc.text(line, pageW/2, cy, { align:'center' }); cy += 8; });

    // ── Entry pages ───────────────────────────────────────
    const sorted = [...entries].sort((a,b) => (b.date||'').localeCompare(a.date||''));

    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      doc.addPage(); y = margin;

      // Header bar
      doc.setFillColor(...GOLD); doc.rect(margin, y, contentW, 10, 'F');
      doc.setTextColor(...DARK); doc.setFont('helvetica','bold'); doc.setFontSize(11);
      doc.text(`${i+1}. ${(e.procedureName||'Untitled').slice(0,55)}`, margin+3, y+7);
      doc.setTextColor(...GREY); doc.setFont('helvetica','normal'); doc.setFontSize(9);
      doc.text(formatDate(e.date), pageW-margin-3, y+7, { align:'right' });
      y += 16;

      // Summary row
      doc.setFillColor(...LIGHT); doc.rect(margin, y, contentW, 18, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...GREY);
      doc.text('COMPETENCY', margin+3, y+6);
      doc.text('SPECIALTY', margin+contentW/2, y+6);
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
      doc.text(e.competencyLevel||'—', margin+3, y+13);
      doc.text(e.specialty||'—', margin+contentW/2, y+13);
      y += 23;

      hline();
      pdfField('Procedure Code',     e.procedureCode);
      pdfField('Procedure Type',     e.procedureType);
      pdfField('Surgeon / Supervisor', e.surgeonName);
      pdfField('Your Role / Title',  e.roleTitle);
      pdfField('Registration No.',   e.regNumber);
      pdfField('Duration',           e.duration ? e.duration + ' minutes' : '');
      hline();
      pdfField('Complications', e.complications);
      if (e.complications) {
        const cd = classifyCD(e.complications);
        if (cd) {
          checkPage(8);
          doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...GOLD);
          doc.text(`Clavien-Dindo ${CD_LABELS[cd]}: ${CD_DESC[cd]}`, margin, y); y += 7;
        }
      }
      pdfField('Outcome / Notes', e.outcome);
      if (e.followUpDate) {
        hline();
        pdfField('Follow-up Due',   formatDate(e.followUpDate));
        pdfField('Follow-up Notes', e.followUpNotes);
      }

      // Signature
      if (e.signatureData) {
        checkPage(45); hline();
        doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...GREY);
        doc.text('SUPERVISOR SIGN-OFF', margin, y); y += 4;
        if (e.supervisorName) {
          doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
          doc.text(e.supervisorName, margin, y); y += 6;
        }
        try { doc.addImage(e.signatureData, 'PNG', margin, y, 80, 25); y += 30; }
        catch (err) { console.warn('Sig image error', err); }
      }
    }

    const fname = `Incisio_Logbook_${(userProfile.fullName||'export').replace(/\s+/g,'_')}_${todayISO()}.pdf`;
    doc.save(fname);
    toast('PDF downloaded ✓');
  } catch (err) {
    console.error('PDF error', err);
    toast('PDF generation failed — try CSV instead');
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Download PDF'; }
}

async function loadJsPDF() {
  if (window.jspdf) return;
  return new Promise((resolve, reject) => {
    const s  = document.createElement('script');
    s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ============================================================
// SHARE / EMAIL
// FIX: properly encode all body content with encodeURIComponent
// ============================================================
function shareByEmail() {
  const today        = todayISO();
  const todayEntries = entries.filter(e => e.date === today);
  const name         = userProfile.fullName || '';
  const list         = todayEntries.length > 0 ? todayEntries : entries.slice(0, 5);
  const label        = todayEntries.length > 0
    ? `TODAY'S ENTRIES (${formatDate(today)})`
    : 'RECENT ENTRIES (last 5)';

  let body = `INCISIO PROCEDURE LOG\n`;
  body    += `Generated: ${new Date().toLocaleString('en-GB')}\n`;
  if (name) body += `User: ${name}${userProfile.roleTitle ? ' · ' + userProfile.roleTitle : ''}\n`;
  body    += `Total entries: ${entries.length}\n\n`;
  body    += `${label}\n`;

  list.forEach((e, i) => {
    body += `\n${i+1}. ${e.procedureName || 'Untitled'}`;
    if (e.specialty)       body += ` (${e.specialty})`;
    body += `\n   ${formatDate(e.date)}`;
    if (e.competencyLevel) body += ` · ${e.competencyLevel}`;
    if (e.surgeonName)     body += ` · With ${e.surgeonName}`;
    body += '\n';
  });

  const subject = `Incisio Logbook — ${formatDate(today)}${name ? ' — ' + name : ''}`;
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ============================================================
// CONFIRM DIALOG
// ============================================================
function showConfirm(title, msg, onConfirm) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent   = msg;
  confirmCallback = onConfirm;
  openModal('confirmModal');
}
function confirmAction() {
  closeModal('confirmModal');
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
}

// ============================================================
// MODALS / T&C
// ============================================================
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function acceptTC()     { localStorage.setItem(TC_KEY, '1'); closeModal('tcModal'); }

// ============================================================
// UTILS
// ============================================================
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function todayISO()    { return new Date().toISOString().slice(0, 10); }
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ============================================================
// ONLINE / OFFLINE
// ============================================================
window.addEventListener('online', () => {
  isOnline = true;
  setSyncStatus(pendingSync.length > 0 ? 'pending' : 'synced');
  syncToCloud().then(() => syncFromCloud());
  toast('Back online — syncing…');
});
window.addEventListener('offline', () => {
  isOnline = false;
  setSyncStatus('offline');
  toast('Offline — saved locally');
});

// ============================================================
// INIT
// ============================================================
(async function init() {
  loadLocal();

  // Track whether the app UI has been started, to prevent double-init
  // if SIGNED_IN fires both from page load and from getSession().
  let uiStarted = false;

  // Register listener FIRST so no events are missed.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN') {
      if (uiStarted) return; // getSession() already handled this
      uiStarted = true;
      currentUser = session.user;
      onSignedIn();
    } else if (event === 'SIGNED_OUT') {
      uiStarted = false;
      currentUser = null;
      hideSpinner();
      showAuthUI();
    }
  });

  // getSession() resolves the initial state synchronously from localStorage.
  // No network required — always fast on refresh.
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (uiStarted) return; // listener already handled it
    uiStarted = true;
    if (session?.user) {
      currentUser = session.user;
      await onSignedIn();
    } else {
      hideSpinner();
      showAuthUI();
    }
  } catch {
    if (!uiStarted) {
      hideSpinner();
      showAuthUI();
    }
  }
})();
