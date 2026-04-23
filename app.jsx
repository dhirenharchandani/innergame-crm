const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── Constants ───
const STORAGE_VERSION = 7;
const BACKUP_REMINDER_DAYS = 3;
const IDB_STORE = 'backups';
const IDB_KEY = 'latest';

// Per-user storage keys (set after auth)
let CURRENT_UID = null;
// Current access token, kept in sync via onAuthStateChange — used by the
// beforeunload flush since Supabase v2 has no _sb.auth.session accessor.
let CURRENT_ACCESS_TOKEN = null;
// Hash of the last payload we successfully cloud-saved, so we can skip
// redundant POSTs when React re-renders without meaningful data changes.
let LAST_SAVED_PAYLOAD_JSON = null;
let STORAGE_KEY, BACKUP_KEY, MASTER_VERSION_KEY, LAST_BACKUP_DOWNLOAD_KEY, IDB_NAME;
const initStorageKeys = (uid) => {
  CURRENT_UID = uid;
  STORAGE_KEY = 'bloom-crm-' + uid + '-data';
  BACKUP_KEY = STORAGE_KEY + '-backup';
  MASTER_VERSION_KEY = STORAGE_KEY + '-master-version';
  LAST_BACKUP_DOWNLOAD_KEY = STORAGE_KEY + '-last-backup-download';
  IDB_NAME = 'bloom-crm-' + uid + '-idb';
  // When a real user signs in, purge any 'anonymous' keys left behind from the pre-auth render
  if (uid && uid !== 'anonymous') {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('bloom-crm-anonymous-')) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch(e) { console.warn('[CRM] Anonymous key cleanup failed:', e); }
  }
};
// Initialize with placeholder until auth
initStorageKeys('anonymous');
const MASTER_DATA_VERSION = '2026-03-19T21';

// ─── IndexedDB Secondary Backup ───
const idbOpen = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const idbSave = async (data) => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const json = JSON.stringify(data);
    const hash = await computeHash(json);
    tx.objectStore(IDB_STORE).put({ json, hash, timestamp: Date.now() }, IDB_KEY);
    // Also keep a timestamped snapshot (max 5)
    tx.objectStore(IDB_STORE).put({ json, hash, timestamp: Date.now() }, 'snapshot-' + Date.now());
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    // Cleanup old snapshots
    const tx2 = db.transaction(IDB_STORE, 'readwrite');
    const store2 = tx2.objectStore(IDB_STORE);
    const allKeys = await new Promise(res => { const r = store2.getAllKeys(); r.onsuccess = () => res(r.result); });
    const snapKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('snapshot-')).sort().reverse();
    snapKeys.slice(5).forEach(k => store2.delete(k));
    db.close();
  } catch(e) { console.warn('[CRM] IDB save failed:', e); }
};

const idbLoad = async () => {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const result = await new Promise((res, rej) => { const r = tx.objectStore(IDB_STORE).get(IDB_KEY); r.onsuccess = () => res(r.result); r.onerror = rej; });
    db.close();
    if (!result) return null;
    // Verify integrity
    const hash = await computeHash(result.json);
    if (hash !== result.hash) { console.error('[CRM] IDB integrity check FAILED'); return null; }
    return JSON.parse(result.json);
  } catch(e) { console.warn('[CRM] IDB load failed:', e); return null; }
};

// ─── Data Integrity Hash ───
const computeHash = async (str) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

// Pipeline stages shipped with the app. Users can rename / reorder these
// from Settings — we just need a non-empty starting set so the Pipeline
// view and cadence editor have something to render.
const DEFAULT_STAGES = [
  'New Lead', 'Contacted', 'Qualified',
  'Proposal Sent', 'Negotiation',
  'Closed Won', 'Closed Lost'
];

const DEFAULT_CADENCE = {
  'New Lead': 3, 'Contacted': 5, 'Qualified': 7,
  'Proposal Sent': 5, 'Negotiation': 3,
  'Closed Won': 30, 'Closed Lost': 30
};

// MASTER_DATA seeds a fresh-install (no cloud row yet). Contacts stay empty
// so new users start clean; stages + cadence come from the real defaults.
const MASTER_DATA = { version: 7, contacts: [], stages: [...DEFAULT_STAGES], cadence: {...DEFAULT_CADENCE} };

const STAGE_COLORS = {
  'New Lead': '#3b82f6', 'Contacted': '#06b6d4',
  'Qualified': '#8b5cf6', 'Proposal Sent': '#f59e0b',
  'Negotiation': '#f97316', 'Closed Won': '#10b981',
  'Closed Lost': '#ef4444'
};

const FALLBACK_COLORS = ['#6366f1','#ec4899','#f97316','#84cc16','#0ea5e9','#a855f7','#14b8a6','#f43f5e','#eab308','#64748b'];

const DEFAULT_STAGNATION = {
  'New Lead': 14, 'Contacted': 10, 'Qualified': 14,
  'Proposal Sent': 21, 'Negotiation': 14,
  'Closed Won': 90, 'Closed Lost': 90, default: 30
};

const STAGE_PROBABILITY = {
  'New Lead': 0.1, 'Contacted': 0.2, 'Qualified': 0.4,
  'Proposal Sent': 0.6, 'Negotiation': 0.8,
  'Closed Won': 1.0, 'Closed Lost': 0.0,
  default: 0.25
};

const getStageProbability = (stage) => STAGE_PROBABILITY[stage] !== undefined ? STAGE_PROBABILITY[stage] : STAGE_PROBABILITY.default;

const getStageColor = (stage) => {
  // Some legacy rows (or cloud payloads) may have a contact with no stage set;
  // fall back to a neutral gray instead of throwing on stage.length.
  if (stage == null || stage === '') return '#9ca3af';
  if (STAGE_COLORS[stage]) return STAGE_COLORS[stage];
  const s = String(stage);
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
};

// ─── Utilities ───
const today = () => new Date().toISOString().split('T')[0];

const daysBetween = (d1, d2) => {
  const a = new Date(d1), b = new Date(d2);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
};

const calculateNextFollowUp = (stage, cadence, fromDate) => {
  const days = (cadence && cadence[stage]) || DEFAULT_CADENCE[stage] || 14;
  const d = fromDate ? new Date(fromDate + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + days);
  const result = d.toISOString().split('T')[0];
  const t = today();
  return result < t ? t : result;
};

const formatDate = (d) => {
  if (!d) return '\u2014';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const getFollowUpStatus = (nextFollowUp) => {
  if (!nextFollowUp) return { label: 'No date', cls: 'text-gray-400' };
  const diff = daysBetween(today(), nextFollowUp);
  if (diff < 0) return { label: Math.abs(diff) + 'd overdue', cls: 'text-red-600 font-bold' };
  if (diff === 0) return { label: 'Today', cls: 'text-orange-500 font-bold' };
  if (diff <= 3) return { label: 'In ' + diff + 'd', cls: 'text-yellow-600' };
  return { label: 'In ' + diff + 'd', cls: 'text-green-600' };
};

const exportContactsToCSV = (contacts) => {
  const headers = ['Name','Company','Stage','Email','Phone','Source','Deal Value','Monthly Revenue','Last Contacted','Next Follow-Up','Priority','Notes','Tags'];
  const rows = contacts.map(c => [
    c.name, c.company||'', c.stage, c.email||'', c.phone||'', c.source||'',
    c.dealValue||0, c.monthlyRevenue||0, c.lastContactDate||'', c.nextFollowUp||'', c.priority||'',
    (c.notes||'').replace(/"/g,'""'), (c.tags||[]).join(';')
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.map(v => '"'+v+'"').join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'crm-contacts-export.csv'; a.click();
  URL.revokeObjectURL(url);
};

// ─── Data Persistence ───
const getDefaultData = () => migrateData(JSON.parse(JSON.stringify(MASTER_DATA)));

const migrateData = (data) => {
  // Repopulate stages/cadence if they're missing OR empty — a previous build
  // accidentally saved empty collections to the cloud.
  if (!Array.isArray(data.stages) || data.stages.length === 0) data.stages = [...DEFAULT_STAGES];
  if (!data.cadence || typeof data.cadence !== 'object' || Object.keys(data.cadence).length === 0) data.cadence = {...DEFAULT_CADENCE};
  if (!data.stagnation || typeof data.stagnation !== 'object' || Object.keys(data.stagnation).length === 0) data.stagnation = {...DEFAULT_STAGNATION};
  const cad = data.cadence;
  const t = today();
  data.contacts = (data.contacts || []).map(c => {
    const migrated = {
      ...c,
      // Backfill stage for legacy rows that somehow made it in without one —
      // prevents getStageColor / filters from blowing up on a missing field.
      stage: c.stage || (data.stages && data.stages[0]) || DEFAULT_STAGES[0],
      tags: c.tags || [],
      interactions: c.interactions || [],
      notesTimeline: c.notesTimeline || [],
      monthlyRevenue: c.monthlyRevenue || 0,
      createdAt: c.createdAt || new Date().toISOString(),
      lastContactDate: c.lastContactDate || c.lastContacted || '',
      stageChangedAt: c.stageChangedAt || new Date().toISOString()
    };
    if (!migrated.nextFollowUp || migrated.nextFollowUp < t) {
      const baseDate = migrated.lastContactDate || t;
      migrated.nextFollowUp = calculateNextFollowUp(migrated.stage, cad, baseDate);
    }
    return migrated;
  });
  data.version = STORAGE_VERSION;
  return data;
};

const loadData = () => {
  try {
    const storedVersion = localStorage.getItem(MASTER_VERSION_KEY);
    if (storedVersion !== MASTER_DATA_VERSION) {
      console.log('[CRM] Master data version mismatch: stored=' + storedVersion + ' current=' + MASTER_DATA_VERSION);
      const oldRaw = localStorage.getItem(STORAGE_KEY);
      if (oldRaw) {
        localStorage.setItem(STORAGE_KEY + '-pre-update-' + Date.now(), oldRaw);
        console.log('[CRM] Backed up old data before master update');
        try {
          const oldData = migrateData(JSON.parse(oldRaw));
          const freshData = getDefaultData();
          const existingIds = new Set((oldData.contacts || []).map(c => c.id));
          const existingNames = new Set((oldData.contacts || []).map(c => c.name.toLowerCase().trim()));
          const newContacts = (freshData.contacts || []).filter(c => !existingIds.has(c.id) && !existingNames.has(c.name.toLowerCase().trim()));
          const mergedStages = [...new Set([...(oldData.stages || []), ...(freshData.stages || [])])];
          const mergedCadence = {...(freshData.cadence || {}), ...(oldData.cadence || {})};
          const merged = {...oldData, contacts: [...oldData.contacts, ...newContacts], stages: mergedStages, cadence: mergedCadence};
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
          localStorage.setItem(MASTER_VERSION_KEY, MASTER_DATA_VERSION);
          console.log('[CRM] Merged: kept ' + oldData.contacts.length + ' existing + added ' + newContacts.length + ' new contacts');
          return merged;
        } catch(e) {
          console.error('[CRM] Merge failed, restoring old data', e);
          const oldData = migrateData(JSON.parse(oldRaw));
          localStorage.setItem(STORAGE_KEY, oldRaw);
          localStorage.setItem(MASTER_VERSION_KEY, MASTER_DATA_VERSION);
          return oldData;
        }
      }
      const freshData = getDefaultData();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(freshData));
      localStorage.setItem(MASTER_VERSION_KEY, MASTER_DATA_VERSION);
      console.log('[CRM] Fresh install: loaded embedded master data (' + freshData.contacts.length + ' contacts)');
      return freshData;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const backup = localStorage.getItem(BACKUP_KEY);
      if (backup) {
        try {
          let bdata = JSON.parse(backup);
          bdata = migrateData(bdata);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(bdata));
          console.log('[CRM] Restored from backup');
          return bdata;
        } catch(e) { console.error('[CRM] Backup restore failed', e); }
      }
      return getDefaultData();
    }
    let data = JSON.parse(raw);
    data = migrateData(data);
    return data;
  } catch (e) {
    console.error('[CRM] Load error:', e);
    try {
      const backup = localStorage.getItem(BACKUP_KEY);
      if (backup) {
        let bdata = JSON.parse(backup);
        return migrateData(bdata);
      }
    } catch(e2) {}
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) localStorage.setItem(STORAGE_KEY + '-emergency-' + Date.now(), raw);
    } catch(e3) {}
    return getDefaultData();
  }
};

const saveData = (data) => {
  try {
    const json = JSON.stringify(data);
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) localStorage.setItem(BACKUP_KEY, existing);
    localStorage.setItem(STORAGE_KEY, json);
    // Also save to IndexedDB as secondary backup
    idbSave(data);
  } catch (e) {
    console.error('[CRM] Save error:', e);
    // Try IndexedDB even if localStorage failed
    idbSave(data);
    toast('localStorage is full \u2014 saved to IndexedDB backup instead.', 'warn');
  }
};

// Async loader that tries IndexedDB if localStorage is empty
const loadDataWithIDBFallback = async (syncData) => {
  // If sync load got real data, just save to IDB as well
  if (syncData && syncData.contacts && syncData.contacts.length > 0) {
    idbSave(syncData);
    return syncData;
  }
  // Try IDB fallback
  console.log('[CRM] Attempting IndexedDB fallback...');
  const idbData = await idbLoad();
  if (idbData && idbData.contacts && idbData.contacts.length > 0) {
    console.log('[CRM] Restored ' + idbData.contacts.length + ' contacts from IndexedDB');
    const migrated = migrateData(idbData);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }
  return syncData;
};

// ─── ContactDetail Component ───
const ContactDetail = ({ contact, onClose, onUpdate, stages, onDelete, cadence }) => {
  const [form, setForm] = useState({...contact});
  const [tagInput, setTagInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [noteType, setNoteType] = useState('General');
  const stgs = stages || DEFAULT_STAGES;

  const handleSave = () => {
    const updated = {...form, tags: form.tags || []};
    const formChanged = JSON.stringify(updated) !== JSON.stringify(contact);
    if (formChanged) {
      // Only recalculate follow-up if stage changed
      const stageChanged = updated.stage !== contact.stage;
      const userSetFollowUp = updated.nextFollowUp !== contact.nextFollowUp;
      if (stageChanged && !userSetFollowUp) {
        updated.nextFollowUp = calculateNextFollowUp(updated.stage, cadence);
      }
      // Never auto-set lastContactDate — only explicit user changes or addNote should update it
    }
    onUpdate(updated);
    onClose();
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !(form.tags||[]).includes(t)) {
      setForm({...form, tags: [...(form.tags||[]), t]});
      setTagInput('');
    }
  };

  const removeTag = (tag) => {
    setForm({...form, tags: (form.tags||[]).filter(t => t !== tag)});
  };

  const addNote = () => {
    const text = noteInput.trim();
    if (!text) return;
    const note = { id: Math.random().toString(36).substr(2, 9), text, type: noteType, date: new Date().toISOString() };
    // Logging a note = real interaction, so update lastContactDate and recalculate follow-up
    const newLastContact = today();
    setForm({...form, notesTimeline: [note, ...(form.notesTimeline||[])], lastContactDate: newLastContact, nextFollowUp: calculateNextFollowUp(form.stage, cadence, newLastContact)});
    setNoteInput('');
  };

  const removeNote = (id) => {
    setForm({...form, notesTimeline: (form.notesTimeline||[]).filter(n => n.id !== id)});
  };

  const handleFieldChange = (field, value) => {
    setForm(prev => ({...prev, [field]: value}));
  };

  const renderField = (label, field, type, options) => (
    <div className="mb-3" key={field}>
      <label className="block text-sm font-medium text-gray-600 mb-1">{label}</label>
      {type === 'select' ? (
        <select value={form[field]||''} onChange={e => handleFieldChange(field, e.target.value)} className="w-full">
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : type === 'textarea' ? (
        <textarea value={form[field]||''} onChange={e => handleFieldChange(field, e.target.value)} className="w-full" rows={3} />
      ) : (
        <input type={type||'text'} value={form[field]||''} onChange={e => handleFieldChange(field, type==='number' ? Number(e.target.value) : e.target.value)} className="w-full" />
      )}
    </div>
  );

  return (
    <div className="detail-panel detail-panel-enter flex flex-col h-full">
      {/* Sticky header */}
      <div className="flex justify-between items-center p-4 pb-3 border-b flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold truncate">{contact.name}</h2>
          {contact.company && <div className="text-xs text-gray-500">{contact.company}</div>}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl ml-2 flex-shrink-0">{'\u00D7'}</button>
      </div>

      {/* Quick contact actions */}
      <div className="flex gap-2 p-4 pb-2 border-b flex-shrink-0">
        {form.email && <a href={'mailto:' + form.email} className="flex-1 text-center py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-medium hover:bg-blue-100 flex items-center justify-center gap-1.5"><Icon name="mail" size={13} /> Email</a>}
        {form.phone && <a href={'tel:' + form.phone} className="flex-1 text-center py-1.5 bg-green-50 text-green-600 rounded-lg text-xs font-medium hover:bg-green-100 flex items-center justify-center gap-1.5"><Icon name="phone" size={13} /> Call</a>}
        <button onClick={() => { document.getElementById('note-input-panel') && document.getElementById('note-input-panel').focus(); }} className="flex-1 text-center py-1.5 bg-purple-50 text-purple-600 rounded-lg text-xs font-medium hover:bg-purple-100 flex items-center justify-center gap-1.5"><Icon name="edit" size={13} /> Note</button>
      </div>

      {/* Scrollable body */}
      <div className="overflow-y-auto flex-1 p-4 pt-3" style={{overflowY: 'scroll'}}>
        {/* Activity Timeline first — this is the CRM centerpiece */}
        <div className="mb-4">
          <label className="block text-sm font-semibold text-gray-700 mb-2">Activity Timeline</label>
          <div className="flex gap-2 mb-2">
            <input id="note-input-panel" value={noteInput} onChange={e => setNoteInput(e.target.value)} onKeyDown={e => e.key==='Enter' && (e.preventDefault(), addNote())} placeholder="Log an interaction..." className="flex-1 text-sm" />
            <select value={noteType} onChange={e => setNoteType(e.target.value)} className="w-24 text-sm">
              <option>General</option><option>Call</option><option>Email</option><option>Meeting</option>
            </select>
            <button onClick={addNote} className="px-3 py-1 bg-green-500 text-white rounded text-sm font-medium">Log</button>
          </div>
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {(form.notesTimeline||[]).length === 0 && <div className="text-xs text-gray-400 text-center py-3">No activity logged yet</div>}
            {(form.notesTimeline||[]).map(n => (
              <div key={n.id} className="bg-gray-50 rounded p-2 text-sm flex justify-between items-start">
                <div>
                  <span className={"text-xs font-medium mr-2 " + (n.type==='Call' ? 'text-green-600' : n.type==='Email' ? 'text-blue-600' : n.type==='Meeting' ? 'text-purple-600' : 'text-gray-600')}>{n.type}</span>
                  <span className="text-gray-700">{n.text}</span>
                  <div className="text-xs text-gray-400 mt-1">{formatDate(n.date)}</div>
                </div>
                <button onClick={() => removeNote(n.id)} className="text-red-400 hover:text-red-600 ml-2 flex-shrink-0">{'\u00D7'}</button>
              </div>
            ))}
          </div>
        </div>

        <hr className="my-3 border-gray-100" />

        {/* Contact details */}
        <details open className="mb-3">
          <summary className="text-sm font-semibold text-gray-700 cursor-pointer mb-2">Contact Details</summary>
          {renderField("Name", "name")}
          {renderField("Company", "company")}
          {renderField("Email", "email", "email")}
          {renderField("Phone", "phone")}
          {renderField("Source", "source", "select", ['Direct','Referral','Network','LinkedIn','Website','Event','Other'])}
        </details>

        <details open className="mb-3">
          <summary className="text-sm font-semibold text-gray-700 cursor-pointer mb-2">Deal & Stage</summary>
          {renderField("Stage", "stage", "select", stgs)}
          {renderField("Deal Value ($)", "dealValue", "number")}
          {renderField("Monthly Revenue ($)", "monthlyRevenue", "number")}
          {renderField("Priority", "priority", "select", ['high','medium','low'])}
          {renderField("Last Contacted", "lastContactDate", "date")}
          {renderField("Next Follow-Up", "nextFollowUp", "date")}
        </details>

        <details className="mb-3">
          <summary className="text-sm font-semibold text-gray-700 cursor-pointer mb-2">Notes</summary>
          {renderField("Notes", "notes", "textarea")}
        </details>

        {/* Tags */}
        <details className="mb-3">
          <summary className="text-sm font-semibold text-gray-700 cursor-pointer mb-2">Tags ({(form.tags||[]).length})</summary>
          <div className="flex flex-wrap gap-1 mb-2">
            {(form.tags||[]).map(tag => (
              <span key={tag} className="tag">
                {tag}
                <button onClick={() => removeTag(tag)} className="ml-1 hover:text-red-500">{'\u00D7'}</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => e.key==='Enter' && (e.preventDefault(), addTag())} placeholder="Add tag..." className="flex-1 text-sm" />
            <button onClick={addTag} className="px-3 py-1 bg-indigo-500 text-white rounded text-sm">Add</button>
          </div>
        </details>
      </div>

      {/* Sticky footer */}
      <div className="flex gap-2 p-4 pt-3 border-t flex-shrink-0">
        <button onClick={handleSave} className="flex-1 py-2 text-white rounded-lg font-medium text-sm hover:opacity-90" style={{background: 'var(--accent)'}}>Save</button>
        <button onClick={async () => {
          const ok = await confirmDialog({
            title: 'Delete contact?',
            body: 'This will permanently remove ' + (contact.name || 'this contact') + ' and all associated notes. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (ok) { onDelete(contact.id); onClose(); toast('Contact deleted', 'success'); }
        }} className="px-3 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 text-sm">Delete</button>
        <button onClick={onClose} className="px-3 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm">Cancel</button>
      </div>
    </div>
  );
};

// ─── TodayView (Morning Briefing) ───
const TodayView = ({ contacts, stages, onSelectContact, onUpdateContact, cadence, user }) => {
  const t = today();
  const stgs = stages || DEFAULT_STAGES;
  const overdue = contacts.filter(c => c.nextFollowUp && c.nextFollowUp < t).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const dueToday = contacts.filter(c => c.nextFollowUp === t);
  const inDays = (d) => { const dt = new Date(t); dt.setDate(dt.getDate() + d); return dt.toISOString().split('T')[0]; };
  const dueTomorrow = contacts.filter(c => c.nextFollowUp === inDays(1));
  const recentNotes = contacts.flatMap(c => (c.notesTimeline||[]).map(n => ({...n, contactName: c.name, contactId: c.id, contact: c}))).sort((a,b) => b.date.localeCompare(a.date)).slice(0, 8);
  const topDeals = contacts.filter(c => c.dealValue > 0).sort((a,b) => b.dealValue - a.dealValue).slice(0, 5);
  const weekAgo = (() => { const d = new Date(t); d.setDate(d.getDate() - 7); return d.toISOString().split('T')[0]; })();
  const contactedThisWeek = contacts.filter(c => c.lastContactDate && c.lastContactDate >= weekAgo).length;
  const totalContacts = contacts.length;

  // Bulk actions
  const bulkMarkContacted = (list) => {
    list.forEach(c => onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)}));
  };
  const bulkSnooze = (list, days) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    const newDate = d.toISOString().split('T')[0];
    list.forEach(c => onUpdateContact({...c, nextFollowUp: newDate}));
  };
  const quickMark = (c) => { onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)}); };
  const quickSnooze = (c, days) => { const d = new Date(); d.setDate(d.getDate() + days); onUpdateContact({...c, nextFollowUp: d.toISOString().split('T')[0]}); };

  // Bulk action bar for a section
  const BulkBar = ({items, color}) => (
    <div className="flex flex-wrap items-center gap-2 mb-2 p-2 rounded-lg" style={{background: color + '10', border: '1px solid ' + color + '30'}}>
      <span className="text-xs font-medium" style={{color}}>All {items.length}:</span>
      <button onClick={() => bulkMarkContacted(items)} className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 active:bg-green-700">Mark All Contacted</button>
      <button onClick={() => bulkSnooze(items, 1)} className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600 active:bg-blue-700">Snooze All +1d</button>
      <button onClick={() => bulkSnooze(items, 3)} className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600 active:bg-blue-700">Snooze All +3d</button>
      <button onClick={() => bulkSnooze(items, 7)} className="px-3 py-1.5 bg-indigo-500 text-white rounded-lg text-xs font-medium hover:bg-indigo-600 active:bg-indigo-700">Snooze All +1w</button>
    </div>
  );

  const ActionCard = ({c, borderColor}) => {
    const fu = getFollowUpStatus(c.nextFollowUp);
    return (
      <div className="bg-white rounded-lg p-3 border flex items-center gap-2 cursor-pointer hover:bg-gray-50 hover:border-blue-300 active:bg-gray-100 transition-colors" style={{borderLeft: '4px solid ' + (borderColor || getStageColor(c.stage))}} onClick={() => onSelectContact(c)}>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{c.name}</div>
          <div className="text-xs text-gray-500 truncate">{c.stage}{c.company ? ' \u00B7 ' + c.company : ''}{c.dealValue ? ' \u00B7 $' + c.dealValue.toLocaleString() : ''}</div>
        </div>
        <div className={"text-xs flex-shrink-0 mr-1 " + fu.cls}>{fu.label}</div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => quickMark(c)} className="px-2.5 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs font-medium hover:bg-green-100 active:bg-green-200" title="Mark contacted"><Icon name="check" size={12} /></button>
          <button onClick={() => quickSnooze(c, 1)} className="px-2 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-medium hover:bg-blue-100 active:bg-blue-200" title="Snooze 1 day">+1d</button>
          <button onClick={() => quickSnooze(c, 3)} className="px-2 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-medium hover:bg-blue-100 active:bg-blue-200" title="Snooze 3 days">+3d</button>
          <button onClick={() => quickSnooze(c, 7)} className="px-2 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-100 active:bg-indigo-200" title="Snooze 1 week">+7d</button>
        </div>
      </div>
    );
  };

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const rawName = (user && user.user_metadata && user.user_metadata.display_name) || (user && user.email ? user.email.split('@')[0] : '');
  const firstName = rawName ? rawName.split(' ')[0] : '';
  const greeting = 'Great ' + part + (firstName ? ', ' + firstName : '');

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{greeting}</h1>
        <p className="text-gray-500 text-sm">{dateStr} &mdash; {contactedThisWeek} of {totalContacts} contacts reached this week</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Overdue</div><div className="text-3xl font-bold text-red-600">{overdue.length}</div></div>
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Due Today</div><div className="text-3xl font-bold text-orange-500">{dueToday.length}</div></div>
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Tomorrow</div><div className="text-3xl font-bold text-blue-600">{dueTomorrow.length}</div></div>
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Reached This Week</div><div className="text-3xl font-bold text-green-600">{contactedThisWeek}</div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: Action items */}
        <div>
          {overdue.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-red-600 mb-2 flex items-center gap-2"><span style={{color:'#dc2626'}}><Icon name="dot" size={14} /></span> Overdue ({overdue.length})</h2>
              <BulkBar items={overdue} color="#ef4444" />
              <div className="space-y-1.5">{overdue.map(c => <ActionCard key={c.id} c={c} borderColor="#ef4444" />)}</div>
            </div>
          )}
          {dueToday.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-orange-600 mb-2 flex items-center gap-2"><span style={{color:'#f97316'}}><Icon name="dot" size={14} /></span> Due Today ({dueToday.length})</h2>
              <BulkBar items={dueToday} color="#f59e0b" />
              <div className="space-y-1.5">{dueToday.map(c => <ActionCard key={c.id} c={c} borderColor="#f59e0b" />)}</div>
            </div>
          )}
          {dueTomorrow.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-blue-600 mb-2 flex items-center gap-2"><span style={{color:'#3b82f6'}}><Icon name="dot" size={14} /></span> Tomorrow ({dueTomorrow.length})</h2>
              <BulkBar items={dueTomorrow} color="#3b82f6" />
              <div className="space-y-1.5">{dueTomorrow.map(c => <ActionCard key={c.id} c={c} borderColor="#3b82f6" />)}</div>
            </div>
          )}
          {overdue.length === 0 && dueToday.length === 0 && dueTomorrow.length === 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
              <div className="text-green-600 font-semibold">All caught up!</div>
              <div className="text-sm text-green-500 mt-1">No urgent follow-ups right now.</div>
            </div>
          )}
        </div>

        {/* Right column: Context */}
        <div>
          {topDeals.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-gray-700 mb-2 flex items-center gap-2"><Icon name="dollar" size={16} /> Top Deals</h2>
              <div className="space-y-1.5">{topDeals.map(c => (
                <div key={c.id} className="bg-white rounded-lg p-3 border flex items-center justify-between cursor-pointer hover:bg-gray-50" onClick={() => onSelectContact(c)}>
                  <div><div className="font-medium text-sm">{c.name}</div><div className="text-xs text-gray-500">{c.stage}</div></div>
                  <div className="text-sm font-bold text-green-600">${c.dealValue.toLocaleString()}</div>
                </div>
              ))}</div>
            </div>
          )}
          {recentNotes.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-gray-700 mb-2 flex items-center gap-2"><Icon name="edit" size={16} /> Recent Activity</h2>
              <div className="space-y-1.5">{recentNotes.map(n => (
                <div key={n.id} className="bg-white rounded-lg p-3 border cursor-pointer hover:bg-gray-50" onClick={() => onSelectContact(n.contact)}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={"text-xs font-medium " + (n.type==='Call' ? 'text-green-600' : n.type==='Email' ? 'text-blue-600' : n.type==='Meeting' ? 'text-purple-600' : 'text-gray-500')}>{n.type}</span>
                    <span className="text-xs font-medium text-gray-700">{n.contactName}</span>
                    <span className="text-xs text-gray-400 ml-auto">{formatDate(n.date)}</span>
                  </div>
                  <div className="text-sm text-gray-600 truncate">{n.text}</div>
                </div>
              ))}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Sparkline (inline SVG mini-chart) ───
const Sparkline = ({ values, color = '#3b82f6', width = 120, height = 32, fill = true }) => {
  if (!values || values.length < 2) return <div style={{width, height}} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - ((v - min) / range) * (height - 4) - 2]);
  const line = points.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const area = 'M ' + line + ' L ' + width + ',' + height + ' L 0,' + height + ' Z';
  return (
    <svg width={width} height={height} viewBox={'0 0 ' + width + ' ' + height} style={{display:'block'}}>
      {fill && <path d={area} fill={color} opacity="0.12" />}
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// ─── DashboardView ───
const DashboardView = ({ contacts, stages, stagnation, onShowStagnant }) => {
  const stgs = stages || DEFAULT_STAGES;
  const totalContacts = contacts.length;
  const stagnantCount = contacts.filter(c => isStagnant(c, stagnation)).length;
  const totalDealValue = contacts.reduce((s, c) => s + (c.dealValue || 0), 0);
  const weightedValue = contacts.reduce((s, c) => s + (c.dealValue || 0) * getStageProbability(c.stage), 0);
  const overdue = contacts.filter(c => c.nextFollowUp && c.nextFollowUp < today()).length;
  const dueToday = contacts.filter(c => c.nextFollowUp === today()).length;

  // 30-day daily series for sparklines.
  // Uses createdAt for cumulative contacts/$ and lastContactDate for activity.
  const trends = useMemo(() => {
    const DAYS = 30;
    const now = new Date(); now.setHours(0,0,0,0);
    const dayKey = (d) => new Date(d).toISOString().split('T')[0];
    const series = Array.from({length: DAYS}, (_, i) => {
      const d = new Date(now); d.setDate(d.getDate() - (DAYS - 1 - i));
      return { key: dayKey(d), contacts: 0, value: 0, weighted: 0, touches: 0 };
    });
    const idx = Object.fromEntries(series.map((s, i) => [s.key, i]));
    contacts.forEach(c => {
      if (c.createdAt) {
        const k = dayKey(c.createdAt);
        if (idx[k] !== undefined) {
          series[idx[k]].contacts += 1;
          series[idx[k]].value += (c.dealValue || 0);
          series[idx[k]].weighted += (c.dealValue || 0) * getStageProbability(c.stage);
        }
      }
      if (c.lastContactDate && idx[c.lastContactDate] !== undefined) {
        series[idx[c.lastContactDate]].touches += 1;
      }
    });
    // Cumulative for growth metrics; touches stays daily for activity feel
    let cC = 0, cV = 0, cW = 0;
    const contactsSeries = [], valueSeries = [], weightedSeries = [], touchesSeries = [];
    series.forEach(s => {
      cC += s.contacts; cV += s.value; cW += s.weighted;
      contactsSeries.push(cC); valueSeries.push(cV); weightedSeries.push(cW);
      touchesSeries.push(s.touches);
    });
    return { contactsSeries, valueSeries, weightedSeries, touchesSeries };
  }, [contacts]);

  // Delta vs 30 days ago (first vs last cumulative value)
  const delta = (arr) => {
    const first = arr[0] || 0;
    const last = arr[arr.length - 1] || 0;
    return last - first;
  };
  const contactsDelta = delta(trends.contactsSeries);
  const valueDelta = delta(trends.valueSeries);
  const weightedDelta = delta(trends.weightedSeries);
  const touchesSum = trends.touchesSeries.reduce((s, n) => s + n, 0);

  // Funnel: all stages in pipeline order, count + $, with conversion % to the next stage
  const funnel = stgs.map(stage => {
    const stageContacts = contacts.filter(c => c.stage === stage);
    const count = stageContacts.length;
    const value = stageContacts.reduce((s, c) => s + (c.dealValue || 0), 0);
    return { stage, count, value, color: getStageColor(stage) };
  });
  const maxFunnelCount = Math.max(...funnel.map(d => d.count), 1);

  const fmtMoney = (n) => n >= 1000 ? '$' + (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : '$' + n.toLocaleString();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>

      {stagnantCount > 0 && (
        <button onClick={onShowStagnant} className="w-full mb-4 flex items-center justify-between gap-3 bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 rounded-lg px-4 py-2.5 text-sm transition-colors">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"></span>
            <span className="font-medium">{stagnantCount} stagnant contact{stagnantCount === 1 ? '' : 's'}</span>
            <span className="text-red-500 hidden sm:inline">{'\u00B7'} no recent touch beyond threshold</span>
          </span>
          <span className="text-xs font-medium">View {'\u2192'}</span>
        </button>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="stat-card rounded-xl p-4">
          <div className="flex items-start justify-between mb-1">
            <div className="text-sm text-gray-500">Total Contacts</div>
            {contactsDelta !== 0 && <div className="text-xs font-medium" style={{color: contactsDelta > 0 ? '#059669' : '#dc2626'}}>{contactsDelta > 0 ? '+' : ''}{contactsDelta} / 30d</div>}
          </div>
          <div className="text-3xl font-bold text-blue-600">{totalContacts}</div>
          <div className="mt-2"><Sparkline values={trends.contactsSeries} color="#3b82f6" /></div>
        </div>

        <div className="stat-card rounded-xl p-4">
          <div className="flex items-start justify-between mb-1">
            <div className="text-sm text-gray-500">Pipeline Value</div>
            {valueDelta !== 0 && <div className="text-xs font-medium" style={{color: valueDelta > 0 ? '#059669' : '#dc2626'}}>{valueDelta > 0 ? '+' : ''}{fmtMoney(valueDelta)} / 30d</div>}
          </div>
          <div className="text-3xl font-bold text-green-600">${totalDealValue.toLocaleString()}</div>
          <div className="mt-2"><Sparkline values={trends.valueSeries} color="#059669" /></div>
        </div>

        <div className="stat-card rounded-xl p-4">
          <div className="flex items-start justify-between mb-1">
            <div className="text-sm text-gray-500">Weighted Value</div>
            {weightedDelta !== 0 && <div className="text-xs font-medium" style={{color: weightedDelta > 0 ? '#059669' : '#dc2626'}}>{weightedDelta > 0 ? '+' : ''}{fmtMoney(weightedDelta)} / 30d</div>}
          </div>
          <div className="text-3xl font-bold text-emerald-600">${Math.round(weightedValue).toLocaleString()}</div>
          <div className="text-xs text-gray-400 mt-1">probability-adjusted</div>
          <div className="mt-1"><Sparkline values={trends.weightedSeries} color="#10b981" /></div>
        </div>

        <div className="stat-card rounded-xl p-4">
          <div className="flex items-start justify-between mb-1">
            <div className="text-sm text-gray-500">Activity (30d)</div>
            <div className="text-xs font-medium text-gray-400">{overdue} overdue &middot; {dueToday} today</div>
          </div>
          <div className="text-3xl font-bold text-purple-600">{touchesSum}</div>
          <div className="text-xs text-gray-400 mt-1">contacts reached</div>
          <div className="mt-1"><Sparkline values={trends.touchesSeries} color="#8b5cf6" fill={true} /></div>
        </div>
      </div>

      {/* Pipeline Funnel */}
      <div className="bg-white rounded-xl border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Pipeline Funnel</h2>
          <div className="text-xs text-gray-400">count &middot; $ value &middot; stage-to-stage %</div>
        </div>
        {totalContacts === 0 ? (
          <div className="text-center text-gray-400 py-8 text-sm">Add contacts to see your pipeline funnel.</div>
        ) : (
          <div className="space-y-1.5">
            {funnel.map((row, i) => {
              const widthPct = Math.max(3, (row.count / maxFunnelCount) * 100);
              const next = funnel[i + 1];
              const conversion = next && row.count > 0 ? Math.round((next.count / row.count) * 100) : null;
              return (
                <div key={row.stage}>
                  <div className="flex items-center gap-3 py-1.5">
                    <div className="w-36 text-sm truncate flex items-center gap-2 flex-shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{background: row.color}}></span>
                      <span className="truncate">{row.stage}</span>
                    </div>
                    <div className="flex-1 relative h-8 bg-gray-50 rounded-md overflow-hidden">
                      <div className="absolute inset-y-0 left-0 rounded-md flex items-center px-3 text-xs font-medium text-white" style={{width: widthPct + '%', background: row.color, minWidth: row.count > 0 ? '2.5rem' : 0}}>
                        {row.count > 0 && <span>{row.count}</span>}
                      </div>
                    </div>
                    <div className="w-24 text-right text-sm flex-shrink-0" style={{color: row.value > 0 ? 'var(--text-primary)' : 'var(--text-tertiary)'}}>
                      {row.value > 0 ? fmtMoney(row.value) : '\u2014'}
                    </div>
                  </div>
                  {conversion !== null && row.count > 0 && (
                    <div className="flex items-center gap-3 pl-36">
                      <div className="flex-1 flex items-center gap-2 pl-2">
                        <span className="text-xs text-gray-400">&darr; {conversion}% advance</span>
                      </div>
                      <div className="w-24" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── ContactsView ───
const ContactsView = ({ contacts, onSelectContact, onUpdateContact, onDeleteContact, stages, cadence, stagnation, stagnantOnly, onClearStagnant }) => {
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('All');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [tagFilter, setTagFilter] = useState('All');
  const [sortBy, setSortBy] = useState('name');
  const [selected, setSelected] = useState(new Set());
  const [showBulkNote, setShowBulkNote] = useState(false);
  const [bulkNoteText, setBulkNoteText] = useState('');
  const [bulkNoteType, setBulkNoteType] = useState('General');
  const stgs = stages || DEFAULT_STAGES;

  const allTags = useMemo(() => {
    const tags = new Set();
    contacts.forEach(c => (c.tags || []).forEach(t => tags.add(t)));
    return [...tags].sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    let list = contacts;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.company||'').toLowerCase().includes(q) ||
        (c.email||'').toLowerCase().includes(q) ||
        (c.tags||[]).some(t => t.toLowerCase().includes(q)) ||
        (c.notes||'').toLowerCase().includes(q) ||
        (c.notesTimeline||[]).some(n => n.text.toLowerCase().includes(q))
      );
    }
    if (stageFilter !== 'All') list = list.filter(c => c.stage === stageFilter);
    if (priorityFilter !== 'All') list = list.filter(c => c.priority === priorityFilter);
    if (tagFilter !== 'All') list = list.filter(c => (c.tags||[]).includes(tagFilter));
    if (stagnantOnly) list = list.filter(c => isStagnant(c, stagnation));
    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'stage') return (stgs.indexOf(a.stage) - stgs.indexOf(b.stage)) || a.name.localeCompare(b.name);
      if (sortBy === 'lastContacted') return (b.lastContactDate||'').localeCompare(a.lastContactDate||'');
      if (sortBy === 'dealValue') return (b.dealValue||0) - (a.dealValue||0);
      if (sortBy === 'priority') { const ord = {high:0,medium:1,low:2}; return (ord[a.priority]||1) - (ord[b.priority]||1) || a.name.localeCompare(b.name); }
      return 0;
    });
    return list;
  }, [contacts, search, stageFilter, priorityFilter, tagFilter, sortBy, stgs, stagnantOnly, stagnation]);

  const toggleSelect = (id) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };

  const handleBulkMove = (stage) => {
    selected.forEach(id => {
      const c = contacts.find(x => x.id === id);
      if (c) onUpdateContact({...c, stage, nextFollowUp: calculateNextFollowUp(stage, cadence), stageChangedAt: new Date().toISOString()});
    });
    setSelected(new Set());
  };

  const handleBulkMarkContacted = () => {
    selected.forEach(id => {
      const c = contacts.find(x => x.id === id);
      if (c) onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)});
    });
    setSelected(new Set());
  };

  const handleBulkAddNote = () => {
    const text = bulkNoteText.trim();
    if (!text) return;
    const note = { id: Math.random().toString(36).substr(2, 9), text, type: bulkNoteType, date: new Date().toISOString() };
    selected.forEach(id => {
      const c = contacts.find(x => x.id === id);
      if (c) {
        onUpdateContact({
          ...c,
          notesTimeline: [note, ...(c.notesTimeline || [])],
          lastContactDate: today(),
          nextFollowUp: calculateNextFollowUp(c.stage, cadence)
        });
      }
    });
    setBulkNoteText('');
    setBulkNoteType('General');
    setShowBulkNote(false);
    setSelected(new Set());
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4"><h1 className="text-2xl font-bold">Contacts ({filtered.length})</h1></div>
      <div className="flex gap-3 mb-4 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, company, email, tags, notes..." className="flex-1 min-w-[200px]" />
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}><option value="All">All Stages</option>{stgs.map(s => <option key={s} value={s}>{s}</option>)}</select>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="All">All Priorities</option>
          <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        {allTags.length > 0 && (
          <select value={tagFilter} onChange={e => setTagFilter(e.target.value)}>
            <option value="All">All Tags</option>{allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="name">Sort by Name</option><option value="stage">Sort by Stage</option>
          <option value="lastContacted">Sort by Last Contacted</option><option value="dealValue">Sort by Deal Value</option>
          <option value="priority">Sort by Priority</option>
        </select>
      </div>
      {(stageFilter !== 'All' || priorityFilter !== 'All' || tagFilter !== 'All' || stagnantOnly) && (
        <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
          <span className="text-gray-500">Active filters:</span>
          {stagnantOnly && <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-xs flex items-center gap-1">Stagnant<button onClick={onClearStagnant} className="hover:text-red-900">{'\u00D7'}</button></span>}
          {stageFilter !== 'All' && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs flex items-center gap-1">{stageFilter}<button onClick={() => setStageFilter('All')} className="hover:text-red-500">{'\u00D7'}</button></span>}
          {priorityFilter !== 'All' && <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full text-xs flex items-center gap-1">{priorityFilter}<button onClick={() => setPriorityFilter('All')} className="hover:text-red-500">{'\u00D7'}</button></span>}
          {tagFilter !== 'All' && <span className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full text-xs flex items-center gap-1">{tagFilter}<button onClick={() => setTagFilter('All')} className="hover:text-red-500">{'\u00D7'}</button></span>}
          <button onClick={() => { setStageFilter('All'); setPriorityFilter('All'); setTagFilter('All'); if (onClearStagnant) onClearStagnant(); }} className="text-xs text-gray-400 hover:text-red-500 ml-1">Clear all</button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center gap-3 flex-wrap">
          <span className="font-medium text-blue-800">{selected.size} selected</span>
          <select onChange={e => { if(e.target.value) handleBulkMove(e.target.value); e.target.value=''; }} defaultValue="">
            <option value="">Move to...</option>{stgs.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={handleBulkMarkContacted} className="px-3 py-1 bg-green-500 text-white rounded text-sm">Mark Contacted</button>
          <button onClick={() => setShowBulkNote(true)} className="px-3 py-1 bg-purple-500 text-white rounded text-sm">Add Note to All</button>
          <button onClick={() => setSelected(new Set())} className="px-3 py-1 bg-gray-200 rounded text-sm">Clear</button>
        </div>
      )}
      {showBulkNote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{background:'rgba(0,0,0,0.4)',backdropFilter:'blur(4px)'}} onClick={() => setShowBulkNote(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">Add Note to {selected.size} Contacts</h2>
              <button onClick={() => setShowBulkNote(false)} className="text-gray-400 hover:text-gray-600 text-2xl">{'\u00D7'}</button>
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-600 mb-1">Note Type</label>
              <select value={bulkNoteType} onChange={e => setBulkNoteType(e.target.value)} className="w-full">
                <option>General</option><option>Call</option><option>Email</option><option>Meeting</option>
              </select>
            </div>
            <div className="mb-3">
              <label className="block text-sm font-medium text-gray-600 mb-1">Note</label>
              <textarea value={bulkNoteText} onChange={e => setBulkNoteText(e.target.value)} className="w-full" rows={4} placeholder="Type your note here... This will be added to all selected contacts." />
            </div>
            <div className="mb-4 bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto">
              <div className="text-xs font-medium text-gray-500 mb-1">Will be added to:</div>
              <div className="flex flex-wrap gap-1">{Array.from(selected).map(id => {
                const c = contacts.find(x => x.id === id);
                return c ? <span key={id} className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{c.name}</span> : null;
              })}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleBulkAddNote} className="flex-1 py-2 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700">Add Note to All</button>
              <button onClick={() => setShowBulkNote(false)} className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
            </div>
          </div>
        </div>
      )}
      {/* Mobile card layout */}
      <div className="contact-cards-mobile space-y-2">
        {filtered.map(c => {
          const fu = getFollowUpStatus(c.nextFollowUp);
          const color = getStageColor(c.stage);
          const stale = isStagnant(c, stagnation);
          const quickMarkContacted = (e) => { e.stopPropagation(); onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)}); };
          const quickSnooze = (e, days) => { e.stopPropagation(); const d = new Date(); d.setDate(d.getDate() + days); onUpdateContact({...c, nextFollowUp: d.toISOString().split('T')[0]}); };
          return (
            <div key={c.id} className="bg-white rounded-lg p-3 border cursor-pointer active:bg-gray-50" style={{borderLeft: '4px solid ' + color}} onClick={() => onSelectContact(c)}>
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate flex items-center gap-2">{stale && <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" title="Stagnant"></span>}{c.name}</div>
                  <div className="text-xs text-gray-500 truncate">{c.company || c.stage}</div>
                </div>
                <span className={"badge ml-2 flex-shrink-0 " + (c.priority === 'high' ? 'bg-red-100 text-red-700' : c.priority === 'low' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700')}>{c.priority}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className={"text-xs " + fu.cls}>{fu.label}</div>
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <button onClick={quickMarkContacted} className="px-2 py-1.5 bg-green-50 text-green-600 rounded text-xs active:bg-green-100"><Icon name="check" size={12} /></button>
                  <button onClick={e => quickSnooze(e, 1)} className="px-2 py-1.5 bg-blue-50 text-blue-600 rounded text-xs active:bg-blue-100">+1d</button>
                  <button onClick={e => quickSnooze(e, 3)} className="px-2 py-1.5 bg-blue-50 text-blue-600 rounded text-xs active:bg-blue-100">+3d</button>
                  <button onClick={e => quickSnooze(e, 7)} className="px-2 py-1.5 bg-blue-50 text-blue-600 rounded text-xs active:bg-blue-100">+7d</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Desktop table layout */}
      <div className="contact-table bg-white rounded-xl border overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-3 text-left w-8"><input type="checkbox" onChange={e => setSelected(e.target.checked ? new Set(filtered.map(c=>c.id)) : new Set())} /></th>
              <th className="p-3 text-left text-sm font-medium text-gray-600">Name</th>
              <th className="p-3 text-left text-sm font-medium text-gray-600">Company</th>
              <th className="p-3 text-left text-sm font-medium text-gray-600">Stage</th>
              <th className="p-3 text-left text-sm font-medium text-gray-600">Follow-Up</th>
              <th className="p-3 text-left text-sm font-medium text-gray-600">Priority</th>
              <th className="p-3 text-left text-sm font-medium text-gray-600 w-36">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const fu = getFollowUpStatus(c.nextFollowUp);
              const color = getStageColor(c.stage);
              const stale = isStagnant(c, stagnation);
              const quickMarkContacted = (e) => {
                e.stopPropagation();
                onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)});
              };
              const quickSnooze = (e, days) => {
                e.stopPropagation();
                const d = new Date(); d.setDate(d.getDate() + days);
                onUpdateContact({...c, nextFollowUp: d.toISOString().split('T')[0]});
              };
              return (
                <tr key={c.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => onSelectContact(c)}>
                  <td className="p-3" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} /></td>
                  <td className="p-3 font-medium"><span className="inline-flex items-center gap-2">{stale && <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" title="Stagnant: no contact beyond threshold"></span>}{c.name}</span></td>
                  <td className="p-3 text-gray-600">{c.company || '\u2014'}</td>
                  <td className="p-3"><span className="px-2 py-1 rounded-full text-xs font-medium text-white" style={{background: color}}>{c.stage}</span></td>
                  <td className={"p-3 text-sm " + fu.cls}>{fu.label}</td>
                  <td className="p-3"><span className={"badge " + (c.priority === 'high' ? 'bg-red-100 text-red-700' : c.priority === 'low' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700')}>{c.priority}</span></td>
                  <td className="p-3" onClick={e => e.stopPropagation()}>
                    <div className="quick-action flex items-center gap-1">
                      <button onClick={quickMarkContacted} className="px-2 py-1 bg-green-50 text-green-600 rounded text-xs hover:bg-green-100" title="Mark contacted"><Icon name="check" size={12} /></button>
                      <button onClick={e => quickSnooze(e, 1)} className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 1 day">+1d</button>
                      <button onClick={e => quickSnooze(e, 3)} className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 3 days">+3d</button>
                      <button onClick={e => quickSnooze(e, 7)} className="px-2 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 1 week">+7d</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─── PipelineView (Kanban) ───
const PipelineView = ({ contacts, onUpdateContact, onSelectContact, stages, cadence }) => {
  const stgs = stages || DEFAULT_STAGES;
  const [dragOver, setDragOver] = useState(null);

  const handleDragStart = (e, contact) => { e.dataTransfer.setData('contactId', contact.id); };
  const handleDrop = (e, stage) => {
    e.preventDefault(); setDragOver(null);
    const id = e.dataTransfer.getData('contactId');
    const contact = contacts.find(c => c.id === id);
    if (contact && contact.stage !== stage) {
      onUpdateContact({...contact, stage, nextFollowUp: calculateNextFollowUp(stage, cadence), stageChangedAt: new Date().toISOString()});
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Pipeline</h1>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stgs.map(stage => {
          const sc = contacts.filter(c => c.stage === stage);
          const color = getStageColor(stage);
          return (
            <div key={stage} className={"pipeline-col flex-shrink-0 bg-gray-50 rounded-xl p-3 " + (dragOver === stage ? 'drag-over' : '')}
              onDragOver={e => { e.preventDefault(); setDragOver(stage); }} onDragLeave={() => setDragOver(null)} onDrop={e => handleDrop(e, stage)}>
              <div className="flex items-center gap-2 mb-3 pb-2 border-b" style={{borderColor: color}}>
                <div className="w-3 h-3 rounded-full" style={{background: color}}></div>
                <span className="font-semibold text-sm truncate">{stage}</span>
                <span className="ml-auto bg-gray-200 text-gray-700 text-xs font-bold px-2 py-0.5 rounded-full">{sc.length}</span>
              </div>
              {sc.map(c => {
                const fu = getFollowUpStatus(c.nextFollowUp);
                return (
                  <div key={c.id} className={"card-drag bg-white rounded-lg p-3 mb-2 shadow-sm cursor-pointer hover:border-blue-400 border " + (fu.cls.includes('red') ? 'border-l-4 border-l-red-400' : fu.cls.includes('orange') ? 'border-l-4 border-l-orange-400' : '')} draggable onDragStart={e => handleDragStart(e, c)} onClick={() => onSelectContact && onSelectContact(c)}>
                    <div className="font-medium text-sm">{c.name}</div>
                    {c.company && <div className="text-xs text-gray-500">{c.company}</div>}
                    <div className="flex items-center justify-between mt-1.5">
                      <div className={"text-xs font-medium " + fu.cls}>{fu.label}</div>
                      {c.nextFollowUp && <div className="text-xs text-gray-400">{formatDate(c.nextFollowUp)}</div>}
                    </div>
                    {(c.tags||[]).length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{c.tags.slice(0,3).map(t => <span key={t} className="text-xs bg-indigo-50 text-indigo-600 px-1 rounded">{t}</span>)}</div>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── DealsView ───
const DealsView = ({ contacts, stages }) => {
  const deals = contacts.filter(c => c.dealValue > 0).sort((a, b) => b.dealValue - a.dealValue);
  const totalValue = deals.reduce((s, c) => s + c.dealValue, 0);
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Deals</h1>
      <div className="stat-card rounded-xl p-4 mb-6">
        <div className="text-sm text-gray-500">Total Pipeline Value</div>
        <div className="text-3xl font-bold text-green-600">${totalValue.toLocaleString()}</div>
        <div className="text-sm text-gray-500 mt-1">{deals.length} active deals</div>
      </div>
      {deals.length === 0 ? <div className="text-center text-gray-400 py-12">No deals with values yet. Edit contacts to add deal values.</div>
      : <div className="space-y-3">{deals.map(c => (
        <div key={c.id} className="bg-white rounded-lg p-4 border flex justify-between items-center">
          <div><div className="font-semibold">{c.name}</div><div className="text-sm text-gray-500">{c.stage}</div></div>
          <div className="text-xl font-bold text-green-600">${c.dealValue.toLocaleString()}</div>
        </div>
      ))}</div>}
    </div>
  );
};

// ─── FollowUpsView ───
const FollowUpsView = ({ contacts, stages, onSelectContact, onUpdateContact, cadence }) => {
  const [stageFilter, setStageFilter] = useState('all');
  const stgs = stages || DEFAULT_STAGES;
  const filtered = stageFilter === 'all' ? contacts : contacts.filter(c => c.stage === stageFilter);

  const t = today();
  const inDays = (d) => { const dt = new Date(t); dt.setDate(dt.getDate() + d); return dt.toISOString().split('T')[0]; };
  const endOfWeek = (() => { const d = new Date(t); d.setDate(d.getDate() + (7 - d.getDay())); return d.toISOString().split('T')[0]; })();
  const endOfNextWeek = (() => { const d = new Date(t); d.setDate(d.getDate() + (14 - d.getDay())); return d.toISOString().split('T')[0]; })();

  const criticalOverdue = filtered.filter(c => c.nextFollowUp && daysBetween(c.nextFollowUp, t) > 7).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const overdue = filtered.filter(c => c.nextFollowUp && c.nextFollowUp < t && daysBetween(c.nextFollowUp, t) <= 7).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const dueToday = filtered.filter(c => c.nextFollowUp === t);
  const tomorrow = filtered.filter(c => c.nextFollowUp === inDays(1));
  const thisWeek = filtered.filter(c => c.nextFollowUp > inDays(1) && c.nextFollowUp <= endOfWeek).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const nextWeek = filtered.filter(c => c.nextFollowUp > endOfWeek && c.nextFollowUp <= endOfNextWeek).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const later = filtered.filter(c => c.nextFollowUp > endOfNextWeek).sort((a,b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  const noDate = filtered.filter(c => !c.nextFollowUp);

  const totalOverdue = criticalOverdue.length + overdue.length;
  const totalActions = totalOverdue + dueToday.length + tomorrow.length;

  const Section = ({title, items, color, borderColor, icon, collapsed}) => {
    const [open, setOpen] = useState(!collapsed);
    if (items.length === 0) return null;
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2 cursor-pointer select-none" onClick={() => setOpen(!open)}>
          <span>{open ? '\u25BC' : '\u25B6'}</span>
          <span className="text-xs">{icon}</span>
          <h2 className="text-base font-semibold" style={{color}}>{title}</h2>
          <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{background: borderColor || color, color: 'white'}}>{items.length}</span>
        </div>
        {open && (
          <div className="space-y-1.5 ml-6">{items.map(c => {
            const diff = c.nextFollowUp ? daysBetween(c.nextFollowUp, t) : null;
            const alertText = diff === null ? 'No date' : diff > 0 ? diff + 'd overdue' : diff === 0 ? 'Today' : Math.abs(diff) === 1 ? 'Tomorrow' : 'In ' + Math.abs(diff) + 'd';
            const alertCls = diff === null ? 'text-gray-400' : diff > 7 ? 'text-red-700 font-bold' : diff > 0 ? 'text-red-500 font-semibold' : diff === 0 ? 'text-orange-500 font-semibold' : 'text-green-600';
            const quickMark = (e) => { e.stopPropagation(); onUpdateContact({...c, lastContactDate: today(), nextFollowUp: calculateNextFollowUp(c.stage, cadence)}); };
            const quickSnooze = (e, days) => { e.stopPropagation(); const d = new Date(); d.setDate(d.getDate() + days); onUpdateContact({...c, nextFollowUp: d.toISOString().split('T')[0]}); };
            return (
              <div key={c.id} className="bg-white rounded-lg p-3 border flex items-center justify-between cursor-pointer hover:bg-gray-50 hover:border-blue-300 transition-colors" style={{borderLeft: '4px solid ' + (borderColor || color)}} onClick={() => onSelectContact(c)}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{c.name}</div>
                  <div className="text-xs text-gray-500 truncate">{c.stage}{c.company ? ' \u00B7 ' + c.company : ''}</div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-3" onClick={e => e.stopPropagation()}>
                  <div className="quick-action flex items-center gap-1">
                    <button onClick={quickMark} className="px-2 py-1 bg-green-50 text-green-600 rounded text-xs hover:bg-green-100" title="Mark contacted"><Icon name="check" size={12} /></button>
                    <button onClick={e => quickSnooze(e, 1)} className="px-1.5 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 1 day">+1d</button>
                    <button onClick={e => quickSnooze(e, 3)} className="px-1.5 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 3 days">+3d</button>
                    <button onClick={e => quickSnooze(e, 7)} className="px-1.5 py-1 bg-blue-50 text-blue-600 rounded text-xs hover:bg-blue-100" title="Snooze 1 week">+7d</button>
                  </div>
                  <div className="text-right">
                    <div className={"text-xs " + alertCls}>{alertText}</div>
                    {c.nextFollowUp && <div className="text-xs text-gray-400">{formatDate(c.nextFollowUp)}</div>}
                    {c.lastContactDate && <div className="text-xs text-gray-300">Last: {formatDate(c.lastContactDate)}</div>}
                  </div>
                </div>
              </div>
            );
          })}</div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold">Follow-Ups</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-500">Stage:</label>
          <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} className="text-sm py-1 px-2">
            <option value="all">All Stages ({contacts.length})</option>
            {stgs.map(s => { const cnt = contacts.filter(c => c.stage === s).length; return <option key={s} value={s}>{s} ({cnt})</option>; })}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="rounded-lg px-3 py-2 bg-red-50 border border-red-200"><div className="text-xs text-red-500">Overdue</div><div className="text-xl font-bold text-red-600">{totalOverdue}</div></div>
        <div className="rounded-lg px-3 py-2 bg-orange-50 border border-orange-200"><div className="text-xs text-orange-500">Today</div><div className="text-xl font-bold text-orange-600">{dueToday.length}</div></div>
        <div className="rounded-lg px-3 py-2 bg-blue-50 border border-blue-200"><div className="text-xs text-blue-500">Tomorrow</div><div className="text-xl font-bold text-blue-600">{tomorrow.length}</div></div>
        <div className="rounded-lg px-3 py-2 bg-green-50 border border-green-200"><div className="text-xs text-green-500">This Week</div><div className="text-xl font-bold text-green-600">{thisWeek.length}</div></div>
        <div className="rounded-lg px-3 py-2 bg-gray-50 border border-gray-200"><div className="text-xs text-gray-500">Action Needed</div><div className="text-xl font-bold text-gray-700">{totalActions}</div></div>
      </div>
      <Section title="Critical Overdue (7+ days)" items={criticalOverdue} color="#991b1b" borderColor="#dc2626" icon={<span style={{color:'#991b1b'}}><Icon name="alert" size={14} /></span>} />
      <Section title="Overdue" items={overdue} color="#dc2626" borderColor="#f87171" icon={<span style={{color:'#dc2626'}}><Icon name="dot" size={12} /></span>} />
      <Section title="Due Today" items={dueToday} color="#d97706" borderColor="#f59e0b" icon={<span style={{color:'#f59e0b'}}><Icon name="dot" size={12} /></span>} />
      <Section title="Tomorrow" items={tomorrow} color="#2563eb" borderColor="#3b82f6" icon={<span style={{color:'#3b82f6'}}><Icon name="dot" size={12} /></span>} />
      <Section title="This Week" items={thisWeek} color="#059669" borderColor="#10b981" icon={<span style={{color:'#10b981'}}><Icon name="dot" size={12} /></span>} />
      <Section title="Next Week" items={nextWeek} color="#6366f1" borderColor="#818cf8" icon={<span style={{color:'#818cf8'}}><Icon name="dot" size={12} /></span>} collapsed />
      <Section title="Later" items={later} color="#6b7280" borderColor="#9ca3af" icon={<span style={{color:'#6b7280'}}><Icon name="clock" size={14} /></span>} collapsed />
      <Section title="No Follow-Up Date" items={noDate} color="#9ca3af" borderColor="#d1d5db" icon={<span style={{color:'#9ca3af'}}><Icon name="help" size={14} /></span>} collapsed />
    </div>
  );
};

// ─── WeeklyDigestView ───
const WeeklyDigestView = ({ contacts, stages }) => {
  const stgs = stages || DEFAULT_STAGES;
  const sd = new Date(); sd.setDate(sd.getDate() - 7);
  const sdStr = sd.toISOString().split('T')[0];
  const recentlyContacted = contacts.filter(c => c.lastContactDate && c.lastContactDate >= sdStr);
  const overdue = contacts.filter(c => c.nextFollowUp && c.nextFollowUp < today());
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Weekly Digest</h1>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Contacted This Week</div><div className="text-3xl font-bold text-blue-600">{recentlyContacted.length}</div></div>
        <div className="stat-card rounded-xl p-4"><div className="text-sm text-gray-500">Overdue Follow-Ups</div><div className="text-3xl font-bold text-red-600">{overdue.length}</div></div>
      </div>
    </div>
  );
};

// ─── SourceROIView ───
const SourceROIView = ({ contacts }) => {
  const sources = {};
  contacts.forEach(c => { const src = c.source || 'Unknown'; if (!sources[src]) sources[src] = {count:0,value:0}; sources[src].count++; sources[src].value += c.dealValue||0; });
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Source ROI</h1>
      <div className="space-y-3">{Object.entries(sources).sort((a,b) => b[1].count - a[1].count).map(([src, data]) => (
        <div key={src} className="bg-white rounded-lg p-4 border">
          <div className="flex justify-between items-center"><div className="font-semibold">{src}</div><div className="text-sm text-gray-500">{data.count} contacts</div></div>
          {data.value > 0 && <div className="text-green-600 font-medium mt-1">${data.value.toLocaleString()} pipeline value</div>}
          <div className="mt-2 bg-gray-100 rounded-full h-2"><div className="bg-blue-500 h-2 rounded-full" style={{width: Math.min(100,(data.count/contacts.length)*100)+'%'}}></div></div>
        </div>
      ))}</div>
    </div>
  );
};

// ─── Stagnation helper (shared) ───
// A contact is stagnant when it has never been contacted, or when the days
// since last contact exceed the stage threshold in data.stagnation.
const isStagnant = (contact, stagnation) => {
  const stag = stagnation || DEFAULT_STAGNATION;
  if (!contact.lastContactDate) return true;
  const threshold = stag[contact.stage] || stag.default || DEFAULT_STAGNATION.default;
  return daysBetween(contact.lastContactDate, today()) > threshold;
};

// ─── CSVImportView ───
const CSVImportView = ({ stages, onImport }) => {
  const stgs = stages || DEFAULT_STAGES;
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [targetStage, setTargetStage] = useState(stgs[0]);
  const [importDone, setImportDone] = useState(false);
  const fileRef = useRef();

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map(line => {
      const vals = []; let current = '', inQuote = false;
      for (let ch of line) { if (ch === '"') inQuote = !inQuote; else if (ch === ',' && !inQuote) { vals.push(current.trim()); current = ''; } else current += ch; }
      vals.push(current.trim()); return vals;
    });
    return { headers, rows };
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const p = parseCSV(ev.target.result);
      if (p) { setParsed(p);
        const autoMap = {}; const fields = ['name','company','email','phone','source','dealValue','notes'];
        fields.forEach(f => { const idx = p.headers.findIndex(h => h.toLowerCase().includes(f.toLowerCase())); if (idx >= 0) autoMap[f] = idx; });
        setMapping(autoMap);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = () => {
    if (!parsed) return;
    const newContacts = parsed.rows.filter(r => r.length > 0 && r.some(v => v)).map((row, i) => ({
      id: 'imp_' + Date.now() + '_' + i,
      name: mapping.name !== undefined ? row[mapping.name] || 'Unknown' : 'Unknown',
      company: mapping.company !== undefined ? row[mapping.company] || '' : '',
      email: mapping.email !== undefined ? row[mapping.email] || '' : '',
      phone: mapping.phone !== undefined ? row[mapping.phone] || '' : '',
      source: mapping.source !== undefined ? row[mapping.source] || 'Import' : 'Import',
      dealValue: mapping.dealValue !== undefined ? Number(row[mapping.dealValue]) || 0 : 0,
      monthlyRevenue: 0,
      notes: mapping.notes !== undefined ? row[mapping.notes] || '' : '',
      stage: targetStage, priority: 'medium', lastContactDate: today(),
      nextFollowUp: calculateNextFollowUp(targetStage),
      tags: ['imported'], interactions: [], notesTimeline: [],
      createdAt: new Date().toISOString(), stageChangedAt: new Date().toISOString()
    }));
    onImport(newContacts); setImportDone(true);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Import Contacts</h1>
      {importDone ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <div className="text-green-800 font-semibold">Import complete!</div>
          <button onClick={() => { setImportDone(false); setParsed(null); }} className="mt-3 px-4 py-2 bg-green-600 text-white rounded-lg">Import More</button>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border p-4 mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Upload CSV File</label>
            <input type="file" accept=".csv" ref={fileRef} onChange={handleFile} className="border-0 p-0" />
          </div>
          {parsed && (
            <>
              <div className="bg-white rounded-xl border p-4 mb-4">
                <h3 className="font-semibold mb-3">Column Mapping</h3>
                <p className="text-sm text-gray-500 mb-3">Found {parsed.headers.length} columns, {parsed.rows.length} rows.</p>
                <div className="grid grid-cols-2 gap-3">
                  {['name','company','email','phone','source','dealValue','notes'].map(field => (
                    <div key={field}><label className="text-sm text-gray-600 capitalize">{field}</label>
                      <select value={mapping[field] !== undefined ? mapping[field] : ''} onChange={e => setMapping({...mapping, [field]: e.target.value === '' ? undefined : Number(e.target.value)})}>
                        <option value="">\u2014 Skip \u2014</option>{parsed.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white rounded-xl border p-4 mb-4">
                <h3 className="font-semibold mb-2">Assign to Stage</h3>
                <select value={targetStage} onChange={e => setTargetStage(e.target.value)}>{stgs.map(s => <option key={s} value={s}>{s}</option>)}</select>
              </div>
              <button onClick={handleImport} className="w-full py-3 text-white rounded-lg font-semibold hover:opacity-90" style={{background: 'var(--accent)'}}>Import {parsed.rows.length} Contacts</button>
            </>
          )}
        </>
      )}
    </div>
  );
};

// ─── StageManager ───
const StageManager = ({ stages, onUpdate, onRenameStage }) => {
  const [newStage, setNewStage] = useState('');
  const [editIdx, setEditIdx] = useState(-1);
  const [editName, setEditName] = useState('');

  const addStage = () => { const s = newStage.trim(); if (s && !stages.includes(s)) { onUpdate([...stages, s]); setNewStage(''); }};
  const removeStage = async (idx) => {
    if (stages.length <= 1) return;
    const ok = await confirmDialog({
      title: 'Remove stage?',
      body: 'Contacts currently in the "' + stages[idx] + '" stage will keep that stage label but you won\u2019t be able to add new ones there. You can re-add the stage later.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) onUpdate(stages.filter((_, i) => i !== idx));
  };
  const startRename = (idx) => { setEditIdx(idx); setEditName(stages[idx]); };
  const confirmRename = () => { const n = editName.trim(); if (n && n !== stages[editIdx]) onRenameStage(stages[editIdx], n); setEditIdx(-1); };
  const moveStage = (idx, dir) => { const ns = [...stages]; const t = idx+dir; if (t<0||t>=ns.length) return; [ns[idx],ns[t]]=[ns[t],ns[idx]]; onUpdate(ns); };

  return (
    <div>
      <h3 className="font-semibold mb-3">Pipeline Stages</h3>
      <div className="space-y-2 mb-3">{stages.map((stage, idx) => (
        <div key={idx} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{background: getStageColor(stage)}}></div>
          {editIdx === idx ? (
            <><input value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => e.key === 'Enter' && confirmRename()} className="flex-1" autoFocus />
            <button onClick={confirmRename} className="text-green-600 text-sm font-medium">Save</button>
            <button onClick={() => setEditIdx(-1)} className="text-gray-400 text-sm">Cancel</button></>
          ) : (
            <><span className="flex-1 text-sm font-medium">{stage}</span>
            <button onClick={() => moveStage(idx,-1)} className="text-gray-400 hover:text-gray-600 text-xs" disabled={idx===0}>{'\u25B2'}</button>
            <button onClick={() => moveStage(idx,1)} className="text-gray-400 hover:text-gray-600 text-xs" disabled={idx===stages.length-1}>{'\u25BC'}</button>
            <button onClick={() => startRename(idx)} className="text-blue-500 text-xs">Rename</button>
            <button onClick={() => removeStage(idx)} className="text-red-400 hover:text-red-600 text-xs">{'\u00D7'}</button></>
          )}
        </div>
      ))}</div>
      <div className="flex gap-2"><input value={newStage} onChange={e => setNewStage(e.target.value)} onKeyDown={e => e.key === 'Enter' && addStage()} placeholder="New stage name..." className="flex-1" />
        <button onClick={addStage} className="px-4 py-2 text-white rounded-lg text-sm hover:opacity-90" style={{background: 'var(--accent)'}}>Add</button>
      </div>
    </div>
  );
};

// ─── CadenceEditor ───
const CadenceEditor = ({ stages, cadence, onUpdate }) => {
  const stgs = stages || DEFAULT_STAGES;
  const cad = cadence || DEFAULT_CADENCE;
  const handleChange = (stage, value) => { const v = parseInt(value); if (v > 0) onUpdate({...cad, [stage]: v}); };
  return (
    <div>
      <h3 className="font-semibold mb-2">Follow-Up Cadence (days)</h3>
      <p className="text-sm text-gray-500 mb-3">How many days after contact before a follow-up is due.</p>
      <div className="space-y-2">{stgs.map(stage => (
        <div key={stage} className="flex items-center gap-3 bg-gray-50 rounded-lg p-2">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{background: getStageColor(stage)}}></div>
          <span className="flex-1 text-sm">{stage}</span>
          <input type="number" min="1" max="365" value={cad[stage] || 14} onChange={e => handleChange(stage, e.target.value)} className="w-20 text-center text-sm" />
          <span className="text-xs text-gray-400">days</span>
        </div>
      ))}</div>
    </div>
  );
};

// ─── StagnationEditor ───
const StagnationEditor = ({ stages, stagnation, onUpdate }) => {
  const stgs = stages || DEFAULT_STAGES;
  const stag = stagnation || DEFAULT_STAGNATION;
  const handleChange = (stage, value) => {
    const v = parseInt(value);
    if (!Number.isFinite(v) || v <= 0) return;
    onUpdate({ ...stag, [stage]: v });
  };
  return (
    <div>
      <h3 className="font-semibold mb-2">Stagnation Thresholds (days)</h3>
      <p className="text-sm text-gray-500 mb-3">After how many days without contact a lead is flagged as stagnant on the Stagnation tab.</p>
      <div className="space-y-2">{stgs.map(stage => (
        <div key={stage} className="flex items-center gap-3 bg-gray-50 rounded-lg p-2">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{background: getStageColor(stage)}}></div>
          <span className="flex-1 text-sm">{stage}</span>
          <input type="number" min="1" max="365" value={stag[stage] || DEFAULT_STAGNATION[stage] || DEFAULT_STAGNATION.default} onChange={e => handleChange(stage, e.target.value)} className="w-20 text-center text-sm" />
          <span className="text-xs text-gray-400">days</span>
        </div>
      ))}</div>
    </div>
  );
};

// ─── PasswordChanger ───
const PasswordChanger = () => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (next.length < 8) { setError('New password must be at least 8 characters'); return; }
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) { setError('New password needs at least one letter and one number'); return; }
    if (next !== confirm) { setError('New password and confirmation don\u2019t match'); return; }
    if (next === current) { setError('New password must be different from the current password'); return; }
    setBusy(true);
    try {
      // Reauthenticate with the current password so we don't let a hijacked
      // session silently rotate credentials.
      const { data: { user } } = await _sb.auth.getUser();
      if (!user || !user.email) throw new Error('No active session');
      const { error: signErr } = await _sb.auth.signInWithPassword({ email: user.email, password: current });
      if (signErr) { setError('Current password is incorrect'); setBusy(false); return; }
      const { error: updErr } = await _sb.auth.updateUser({ password: next });
      if (updErr) throw updErr;
      setCurrent(''); setNext(''); setConfirm('');
      toast('Password updated', 'success');
    } catch(err) {
      setError(err.message || 'Could not update password');
      if (window.Sentry) Sentry.captureException(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3 className="font-semibold mb-2">Change Password</h3>
      <p className="text-sm text-gray-500 mb-3">We'll ask for your current password to confirm it's you.</p>
      <div className="space-y-2 max-w-md">
        <input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} placeholder="Current password" className="w-full" disabled={busy} />
        <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} placeholder="New password (8+ chars, letter + number)" className="w-full" disabled={busy} />
        <input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Confirm new password" className="w-full" disabled={busy} />
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button type="submit" disabled={busy || !current || !next || !confirm} className="px-4 py-2 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50" style={{background: 'var(--accent)'}}>{busy ? 'Updating\u2026' : 'Update password'}</button>
      </div>
    </form>
  );
};

// ─── SettingsView ───
const SettingsView = ({ stages, onUpdateStages, onRenameStage, cadence, onUpdateCadence, stagnation, onUpdateStagnation, contacts, onExport, onRestoreBackup, onDownloadJSON, onRestoreFile, onRestorePreUpdate }) => {
  const fileRef = useRef();
  const preUpdateKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_KEY + '-pre-update-')) preUpdateKeys.push(k);
  }
  preUpdateKeys.sort().reverse();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="bg-white rounded-xl border p-4 mb-6"><CadenceEditor stages={stages} cadence={cadence} onUpdate={onUpdateCadence} /></div>
      <div className="bg-white rounded-xl border p-4 mb-6"><StagnationEditor stages={stages} stagnation={stagnation} onUpdate={onUpdateStagnation} /></div>
      <details className="bg-white rounded-xl border p-4 mb-6 group">
        <summary className="font-semibold cursor-pointer list-none flex items-center justify-between">
          <span>Advanced: customize pipeline stages</span>
          <span className="text-xs text-gray-400 group-open:hidden">Most users can skip this</span>
          <span className="text-xs text-gray-400 hidden group-open:inline">Click to collapse</span>
        </summary>
        <div className="mt-4 pt-4 border-t">
          <StageManager stages={stages} onUpdate={onUpdateStages} onRenameStage={onRenameStage} />
        </div>
      </details>
      <div className="bg-white rounded-xl border p-4 mb-6">
        <h3 className="font-semibold mb-3">Export & Backup</h3>
        <div className="flex gap-3 flex-wrap">
          <button onClick={onExport} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm">Export CSV</button>
          <button onClick={onDownloadJSON} className="px-4 py-2 text-white rounded-lg text-sm hover:opacity-90" style={{background: 'var(--accent)'}}>Download JSON Backup</button>
        </div>
      </div>
      <div className="bg-white rounded-xl border p-4 mb-6">
        <h3 className="font-semibold mb-3">Data Recovery</h3>
        <div className="flex gap-3 flex-wrap">
          <button onClick={onRestoreBackup} className="px-4 py-2 bg-yellow-500 text-white rounded-lg text-sm">Restore from Auto-Backup</button>
          <div><button onClick={() => fileRef.current && fileRef.current.click()} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm">Restore from JSON File</button>
            <input type="file" ref={fileRef} accept=".json" className="hidden" onChange={e => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (ev) => { onRestoreFile(ev.target.result); }; reader.readAsText(file); }} />
          </div>
        </div>
        {preUpdateKeys.length > 0 && (
          <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <h4 className="font-medium text-amber-800 text-sm mb-2">Pre-Update Backups ({preUpdateKeys.length})</h4>
            <p className="text-xs text-amber-600 mb-2">Snapshots taken before a master data reset.</p>
            <div className="space-y-1">
              {preUpdateKeys.map(k => {
                const ts = parseInt(k.split('-pre-update-')[1]);
                const dateStr = ts ? new Date(ts).toLocaleString() : k;
                return (
                  <div key={k} className="flex items-center justify-between bg-white rounded p-2 border">
                    <span className="text-xs text-gray-600">{dateStr}</span>
                    <button onClick={() => onRestorePreUpdate(k)} className="px-3 py-1 bg-amber-500 text-white rounded text-xs font-medium hover:bg-amber-600">Restore This</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {(() => {
          const autoKeys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(STORAGE_KEY + '-auto-timed-')) autoKeys.push(k);
          }
          autoKeys.sort().reverse();
          if (autoKeys.length === 0) return null;
          return (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <h4 className="font-medium text-blue-800 text-sm mb-2">Timed Auto-Backups ({autoKeys.length})</h4>
              <p className="text-xs text-blue-600 mb-2">Saved every 30 minutes while the CRM is open.</p>
              <div className="space-y-1">
                {autoKeys.map((k, i) => {
                  const ts = parseInt(k.split('-auto-timed-')[1]);
                  const dateStr = ts ? new Date(ts).toLocaleString() : k;
                  return (
                    <div key={k} className="flex items-center justify-between bg-white rounded p-2 border">
                      <span className="text-xs text-gray-600">{dateStr}{i === 0 ? ' (latest)' : ''}</span>
                      <button onClick={() => onRestorePreUpdate(k)} className="px-3 py-1 bg-blue-500 text-white rounded text-xs font-medium hover:bg-blue-600">Restore This</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
      <div className="bg-white rounded-xl border p-4 mb-6"><PasswordChanger /></div>
      <div className="bg-white rounded-xl border p-4">
        <h3 className="font-semibold mb-2">About</h3>
        <p className="text-sm text-gray-500">InnerGame CRM v{STORAGE_VERSION}</p>
        <p className="text-sm text-gray-500">Data stored locally in your browser. {contacts.length} contacts loaded.</p>
      </div>
    </div>
  );
};

// ─── Global Toast + Modal store ────────────────────────────────────────────
// Lets any component fire a toast or a confirm dialog without prop-drilling.
// Usage anywhere in the code:
//   toast('Saved')
//   toast('Something failed', 'error')
//   confirmDialog({ title, body, danger, confirmLabel }).then(ok => { ... })
// A single <ToastContainer/> and <ConfirmHost/> mount near the root.
let _toastId = 0;
const _toastStore = { toasts: [], listeners: new Set() };
const _notifyToasts = () => _toastStore.listeners.forEach(fn => fn([..._toastStore.toasts]));
const toast = (message, kind = 'info') => {
  const id = ++_toastId;
  const item = { id, message, kind };
  _toastStore.toasts.push(item);
  _notifyToasts();
  const ttl = kind === 'error' ? 5000 : 2800;
  setTimeout(() => {
    _toastStore.toasts = _toastStore.toasts.filter(t => t.id !== id);
    _notifyToasts();
  }, ttl);
  return id;
};
const useToasts = () => {
  const [list, setList] = useState(_toastStore.toasts);
  useEffect(() => { _toastStore.listeners.add(setList); return () => _toastStore.listeners.delete(setList); }, []);
  return list;
};

let _confirmResolver = null;
const _confirmStore = { state: null, listeners: new Set() };
const _notifyConfirm = () => _confirmStore.listeners.forEach(fn => fn(_confirmStore.state));
// Returns a Promise<boolean>. options: { title, body, confirmLabel, cancelLabel, danger }
const confirmDialog = (options) => {
  return new Promise((resolve) => {
    _confirmResolver = resolve;
    _confirmStore.state = {
      title: options.title || 'Are you sure?',
      body: options.body || '',
      confirmLabel: options.confirmLabel || 'Confirm',
      cancelLabel: options.cancelLabel || 'Cancel',
      danger: !!options.danger,
    };
    _notifyConfirm();
  });
};
const _closeConfirm = (result) => {
  _confirmStore.state = null;
  _notifyConfirm();
  const r = _confirmResolver;
  _confirmResolver = null;
  if (r) r(result);
};
const useConfirm = () => {
  const [state, setState] = useState(_confirmStore.state);
  useEffect(() => { _confirmStore.listeners.add(setState); return () => _confirmStore.listeners.delete(setState); }, []);
  return state;
};

// ─── Supabase Sync Layer ───
// Tracks the most recent cloud save attempt so the UI can reflect state.
// Values: 'idle' | 'saving' | 'saved' | 'error'
let _cloudSaveStatus = { value: 'idle', listeners: new Set() };
const setCloudSaveStatus = (v) => { _cloudSaveStatus.value = v; _cloudSaveStatus.listeners.forEach(fn => fn(v)); };
const useCloudSaveStatus = () => {
  const [status, setStatus] = useState(_cloudSaveStatus.value);
  useEffect(() => {
    _cloudSaveStatus.listeners.add(setStatus);
    return () => _cloudSaveStatus.listeners.delete(setStatus);
  }, []);
  return status;
};

// Supabase/PostgREST returns plain objects {code, details, hint, message} on
// failure. Wrap them as a proper Error so Sentry can stringify them properly
// and we can attach the raw fields as context for debugging.
const reportCloudError = (op, raw, extras) => {
  const err = new Error('[' + op + '] ' + (raw && raw.message ? raw.message : 'unknown Supabase error'));
  if (raw && raw.code) err.code = raw.code;
  if (raw && raw.details) err.details = raw.details;
  if (raw && raw.hint) err.hint = raw.hint;
  if (raw && raw.stack) err.stack = raw.stack;
  console.error('[CRM] ' + op + ' failed:', { code: raw && raw.code, message: raw && raw.message, details: raw && raw.details, hint: raw && raw.hint });
  if (window.Sentry) {
    Sentry.withScope(scope => {
      scope.setTag('operation', op);
      if (raw && raw.code) scope.setTag('pg_code', raw.code);
      scope.setContext('supabase_error', {
        code: (raw && raw.code) || null,
        message: (raw && raw.message) || null,
        details: (raw && raw.details) || null,
        hint: (raw && raw.hint) || null,
      });
      if (extras) scope.setContext('extras', extras);
      Sentry.captureException(err);
    });
  }
  return err;
};

const cloudSave = async (data) => {
  if (!CURRENT_UID) return;
  setCloudSaveStatus('saving');
  try {
    const { error } = await _sb.from('crm_data').upsert({
      user_id: CURRENT_UID,
      payload: data,
      updated_at: new Date().toISOString()
    });
    if (error) {
      reportCloudError('cloud_save', error, {
        uid_prefix: CURRENT_UID ? CURRENT_UID.slice(0, 8) : null,
        contact_count: (data.contacts || []).length,
      });
      setCloudSaveStatus('error');
      return;
    }
    try { LAST_SAVED_PAYLOAD_JSON = JSON.stringify(data); } catch(_) { LAST_SAVED_PAYLOAD_JSON = null; }
    console.log('[CRM] Cloud save OK (' + (data.contacts||[]).length + ' contacts)');
    setCloudSaveStatus('saved');
  } catch(e) {
    // Network / runtime errors (not PostgREST response errors)
    reportCloudError('cloud_save_network', { message: e && e.message ? e.message : String(e), stack: e && e.stack });
    setCloudSaveStatus('error');
  }
};

const cloudLoad = async () => {
  if (!CURRENT_UID) return null;
  try {
    const { data, error } = await _sb.from('crm_data').select('payload').eq('user_id', CURRENT_UID).single();
    if (error && error.code === 'PGRST116') return null; // no row found
    if (error) {
      reportCloudError('cloud_load', error, { uid_prefix: CURRENT_UID.slice(0, 8) });
      return null;
    }
    return data ? data.payload : null;
  } catch(e) {
    reportCloudError('cloud_load_network', { message: e && e.message ? e.message : String(e), stack: e && e.stack });
    return null;
  }
};

// ─── Auth Wrapper & Login/Signup Screen ───
const AuthScreen = ({ onAuth, loading }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(''); // non-error success message
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState('login'); // 'login' or 'signup'
  const [resetSent, setResetSent] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setChecking(true);
    try {
      if (mode === 'signup') {
        // Enforce stronger password (8+ chars, at least one letter & number)
        if (password.length < 8) { setError('Password must be at least 8 characters'); setChecking(false); return; }
        if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { setError('Password needs at least one letter and one number'); setChecking(false); return; }
        const { data: signUpData, error: signUpErr } = await _sb.auth.signUp({
          email, password,
          options: { data: { display_name: name || '' } }
        });
        if (signUpErr) throw signUpErr;
        if (signUpData.user && !signUpData.session) {
          setError('');
          setResetSent(false);
          setChecking(false);
          setConfirmationSent(true);
          return;
        }
      } else {
        const { error: signInErr } = await _sb.auth.signInWithPassword({ email, password });
        if (signInErr) throw signInErr;
      }
    } catch(err) {
      // Make Supabase errors more user-friendly
      let msg = err.message || 'Something went wrong';
      if (/invalid login credentials/i.test(msg)) msg = 'Email or password is incorrect.';
      else if (/user already registered/i.test(msg)) msg = 'An account with that email already exists. Try signing in.';
      else if (/email not confirmed/i.test(msg)) msg = 'Please confirm your email first — check your inbox.';
      else if (/rate limit/i.test(msg)) msg = 'Too many attempts. Please wait a moment and try again.';
      setError(msg);
    }
    setChecking(false);
  };

  const handleForgotPassword = async () => {
    if (!email) { setError('Enter your email first'); return; }
    try {
      const { error: resetErr } = await _sb.auth.resetPasswordForEmail(email, {
        // Do NOT append '#type=recovery' here — Supabase automatically attaches the
        // access_token fragment to redirectTo. If we also append '#type=recovery' we end
        // up with a double-hash URL like '/#type=recovery#access_token=...' which breaks
        // the Supabase client's URL parser and prevents session establishment.
        redirectTo: window.location.origin + window.location.pathname
      });
      if (resetErr) throw resetErr;
      setResetSent(true);
      setError('');
    } catch(err) { setError(err.message || 'Could not send reset email. Check the address.'); }
  };

  // Post-signup "check your email" screen
  if (confirmationSent) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div style={{fontSize: '48px', marginBottom: '16px'}}>{'\uD83D\uDCE7'}</div>
          <h1 className="text-2xl font-bold mb-2" style={{color: 'var(--text-primary)'}}>Check your email</h1>
          <p className="text-sm mb-4" style={{color: 'var(--text-secondary)'}}>
            We sent a confirmation link to <strong style={{color:'var(--text-primary)'}}>{email}</strong>.
            Click the link to activate your account, then return here to sign in.
          </p>
          <p className="text-xs mb-6" style={{color: 'var(--text-tertiary)'}}>
            Didn't get it? Check your spam folder, or try signing up again with a different address.
          </p>
          <button onClick={() => { setConfirmationSent(false); setMode('login'); setPassword(''); }} className="login-btn">
            Back to sign in
          </button>
        </div>
        <div className="text-center text-xs mt-6" style={{color: 'var(--text-tertiary)'}}>
          Developed by InnerGame Consulting
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="logo-mark.png" alt="InnerGame" style={{maxWidth: '220px', width: '100%', height: 'auto', display: 'block', margin: '0 auto 16px'}} />
        <div className="text-center mb-6">
          <div className="text-lg font-semibold" style={{color: 'var(--text-primary)'}}>CRM</div>
          <div className="text-sm mt-1" style={{color: 'var(--text-secondary)'}}>{mode === 'login' ? 'Sign in to your CRM' : 'Create your account'}</div>
        </div>
        {loading ? (
          <div>
            <div className="skeleton" style={{height:44,borderRadius:8,marginBottom:12}} />
            <div className="skeleton" style={{height:44,borderRadius:8,marginBottom:12}} />
            <div className="skeleton" style={{height:44,borderRadius:8,marginBottom:12,opacity:0.6}} />
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {mode === 'signup' && (
              <input type="text" className="login-input" placeholder="Your name" value={name}
                onChange={e => setName(e.target.value)} autoComplete="name" />
            )}
            <input type="email" className="login-input" placeholder="Email" value={email}
              onChange={e => { setEmail(e.target.value); setResetSent(false); }} autoComplete="email" autoFocus />
            <input type="password" className="login-input" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            {error && <div className="login-error">{error}</div>}
            {resetSent && <div className="text-sm text-green-600 mb-3">Password reset email sent! Check your inbox.</div>}
            <button type="submit" className="login-btn" disabled={checking || !email || !password}>
              {checking ? (mode === 'login' ? 'Signing in...' : 'Creating account...') : (mode === 'login' ? 'Sign In' : 'Create Account')}
            </button>
            {mode === 'login' && (
              <button type="button" onClick={handleForgotPassword} className="text-sm hover:underline mt-3 block w-full text-center" style={{color: 'var(--text-tertiary)'}}>
                Forgot password?
              </button>
            )}
            <div className="mt-4 text-sm text-center" style={{color: 'var(--text-secondary)'}}>
              {mode === 'login' ? (
                <span>Don't have an account? <button type="button" onClick={() => { setMode('signup'); setError(''); }} className="font-semibold hover:underline" style={{color: 'var(--accent)'}}>Sign up</button></span>
              ) : (
                <span>Already have an account? <button type="button" onClick={() => { setMode('login'); setError(''); }} className="font-semibold hover:underline" style={{color: 'var(--accent)'}}>Sign in</button></span>
              )}
            </div>
          </form>
        )}
      </div>
      <div className="text-center text-xs mt-6" style={{color: 'var(--text-tertiary)'}}>
        Developed by InnerGame Consulting
      </div>
    </div>
  );
};

const ResetPasswordScreen = ({ onDone }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // Establish the recovery session before letting the user submit.
  // Supabase email links can use either: (a) implicit flow with #access_token&type=recovery
  // in the hash, or (b) PKCE flow with ?code=xxx in the search string.
  // The supabase-js client auto-detects both IF we give it a tick, but on some
  // mobile browsers the page is rendered before that resolves — leading to
  // "Auth session missing!" on submit. This effect waits for the session.
  useEffect(() => {
    let cancelled = false;
    const establishSession = async () => {
      // First try to find an existing session
      const { data: { session } } = await _sb.auth.getSession();
      if (session) { if (!cancelled) setSessionReady(true); return; }
      // PKCE flow: ?code=... needs to be exchanged
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        try {
          await _sb.auth.exchangeCodeForSession(window.location.href);
        } catch (e) { console.warn('[CRM] exchangeCodeForSession failed:', e); }
        const { data: { session: s2 } } = await _sb.auth.getSession();
        if (s2 && !cancelled) { setSessionReady(true); return; }
      }
      // Implicit flow: supabase-js auto-parses the hash; subscribe to the PASSWORD_RECOVERY event
      const { data: { subscription } } = _sb.auth.onAuthStateChange((event, sess) => {
        if (sess && !cancelled) setSessionReady(true);
      });
      // Safety: if nothing resolves within 5s, let the user proceed (maybe we'll catch it on submit)
      setTimeout(() => { if (!cancelled) setSessionReady(true); subscription.unsubscribe(); }, 5000);
    };
    establishSession();
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { setError('Password needs at least one letter and one number'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setSaving(true);
    try {
      // Double-check we have a session; if not, try to recover it one more time
      const { data: { session } } = await _sb.auth.getSession();
      if (!session) {
        throw new Error('Your reset link has expired or was already used. Please request a new password reset email.');
      }
      const { error: updErr } = await _sb.auth.updateUser({ password });
      if (updErr) throw updErr;
      // Clean the URL so the recovery hash is gone
      window.history.replaceState({}, document.title, window.location.pathname);
      onDone();
    } catch(err) { setError(err.message || 'Could not update password'); }
    setSaving(false);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div style={{fontSize: '48px', marginBottom: '16px'}}>{'\uD83D\uDD11'}</div>
        <h1 className="text-2xl font-bold mb-2" style={{color: 'var(--text-primary)'}}>Set a new password</h1>
        <p className="text-sm mb-6" style={{color: 'var(--text-secondary)'}}>Choose a new password for your account.</p>
        <form onSubmit={handleSubmit}>
          <input type="password" className="login-input" placeholder="New password (8+ chars, letter + number)" value={password}
            onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          <input type="password" className="login-input" placeholder="Confirm new password" value={confirm}
            onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
          {error && <div className="login-error">{error}</div>}
          {!sessionReady && !error && <div className="text-xs mb-2" style={{color:'var(--text-tertiary)'}}>Verifying reset link...</div>}
          <button type="submit" className="login-btn" disabled={saving || !sessionReady || !password || !confirm}>
            {saving ? 'Saving...' : !sessionReady ? 'Please wait...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
};

const WelcomeScreen = ({ onImport, onSkip, userName }) => {
  const fileRef = useRef();
  const [importing, setImporting] = useState(false);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || typeof data !== 'object' || !Array.isArray(data.contacts)) {
          throw new Error('Backup file is missing a contacts array');
        }
        onImport(data);
      } catch(err) { toast('Invalid backup file: ' + (err.message || 'unknown error'), 'error'); setImporting(false); }
    };
    reader.readAsText(file);
  };

  // Check if there's localStorage data to auto-migrate
  const localData = useMemo(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { const d = JSON.parse(raw); if (d.contacts && d.contacts.length > 0) return d; }
    } catch(e) {}
    return null;
  }, []);

  return (
    <div className="login-screen">
      <div className="login-card">
        <div style={{fontSize: '48px', marginBottom: '16px'}}>{'\uD83C\uDF31'}</div>
        <h1 className="text-xl font-bold mb-2" style={{color: 'var(--text-primary)'}}>Welcome{userName ? ', ' + userName : ''}!</h1>
        <p className="text-sm mb-6" style={{color: 'var(--text-secondary)'}}>Your CRM is ready. Import existing data or start fresh.</p>

        {localData && (
          <div className="mb-4">
            <button onClick={() => { setImporting(true); onImport(localData); }}
              className="w-full py-3 text-white rounded-lg font-semibold hover:opacity-90 mb-3" style={{background: 'var(--accent)'}}>
              {importing ? 'Importing...' : 'Import from this browser (' + localData.contacts.length + ' contacts)'}
            </button>
            <div className="text-xs mb-3" style={{color: 'var(--text-tertiary)'}}>Found existing data in this browser's storage</div>
          </div>
        )}

        <div className="mb-4">
          <button onClick={() => fileRef.current && fileRef.current.click()}
            className="w-full py-3 rounded-lg font-semibold border" style={{background: 'var(--bg-tertiary)', color: 'var(--text-primary)', borderColor: 'var(--border)'}}>
            Upload JSON Backup File
          </button>
          <input type="file" ref={fileRef} accept=".json" className="hidden" onChange={handleFile} />
        </div>

        <button onClick={onSkip} className="text-sm hover:underline" style={{color: 'var(--text-tertiary)'}}>
          Start fresh (empty CRM)
        </button>
      </div>
    </div>
  );
};

// ─── App Wrapper (handles auth + data loading) ───
const AppWrapper = () => {
  const [currentUser, setCurrentUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [cloudData, setCloudData] = useState(undefined);
  const [migrationDone, setMigrationDone] = useState(false);
  const [isRecovery, setIsRecovery] = useState(() => window.location.hash.includes('type=recovery'));

  // Listen to Supabase auth state
  useEffect(() => {
    _sb.auth.getSession().then(({ data: { session } }) => {
      CURRENT_ACCESS_TOKEN = session?.access_token || null;
      const user = session?.user || null;
      if (user) initStorageKeys(user.id);
      if (window.Sentry) Sentry.setUser(user ? { id: user.id, email: user.email } : null);
      setCurrentUser(user);
      setAuthChecked(true);
    }).catch(e => {
      console.error('[CRM] getSession failed:', e);
      if (window.Sentry) Sentry.captureException(e);
      // Fail open — let the user see the auth screen rather than hang on skeleton.
      setAuthChecked(true);
    });
    const { data: { subscription } } = _sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
      CURRENT_ACCESS_TOKEN = session?.access_token || null;
      const user = session?.user || null;
      if (user) initStorageKeys(user.id);
      if (window.Sentry) Sentry.setUser(user ? { id: user.id, email: user.email } : null);
      setCurrentUser(prev => {
        // Avoid triggering downstream effects when the user identity didn't change
        // (onAuthStateChange fires on token refresh too).
        if (prev && user && prev.id === user.id) return prev;
        return user;
      });
      setAuthChecked(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Force dark mode on pre-auth screens (login / password recovery /
  // welcome-import). Once the user is authenticated the App component
  // applies their own saved theme preference.
  useEffect(() => {
    const preAuth = !currentUser || isRecovery;
    if (preAuth) {
      document.documentElement.classList.add('dark');
    }
  }, [currentUser, isRecovery]);

  // Load cloud data when user is authenticated.
  // Depend on currentUser?.id (not the whole user object) so token refreshes
  // don't re-trigger a cloud fetch when the session rolls over.
  // NOTE: Must be declared BEFORE any conditional returns to satisfy Rules of Hooks
  useEffect(() => {
    if (!currentUser) return;
    setCloudData(undefined);
    setMigrationDone(false);
    cloudLoad().then(d => {
      setCloudData(d || null);
      if (d) setMigrationDone(true);
    }).catch(e => {
      console.error('[CRM] cloudLoad failed:', e);
      if (window.Sentry) Sentry.captureException(e);
      // Fall through to WelcomeScreen rather than hang on the skeleton
      setCloudData(null);
    });
  }, [currentUser?.id]);

  // If we're in a password recovery flow, show the reset screen
  if (isRecovery) {
    return <ResetPasswordScreen onDone={() => { setIsRecovery(false); }} />;
  }

  // Waiting for auth check
  if (!authChecked) return <AuthScreen loading={true} />;

  // Not logged in
  if (!currentUser) return <AuthScreen loading={false} />;

  // Loading cloud data after auth — show the full-app skeleton so the
  // transition feels smooth instead of flashing the auth screen again
  if (cloudData === undefined && !migrationDone) {
    return <AppSkeleton />;
  }

  // No cloud data — show welcome/import screen
  if (cloudData === null && !migrationDone) {
    const userName = currentUser.user_metadata?.display_name || '';
    return <WelcomeScreen userName={userName} onSkip={() => { setMigrationDone(true); setCloudData(null); }}
      onImport={async (d) => {
        const migrated = migrateData(d);
        await cloudSave(migrated);
        setCloudData(migrated);
        setMigrationDone(true);
      }} />;
  }

  return <App user={currentUser} initialCloudData={cloudData} />;
};

// ─── App Component ───
const App = ({ user, initialCloudData }) => {
  const [data, setData] = useState(() => {
    if (initialCloudData) return migrateData(initialCloudData);
    return loadData();
  });
  const cloudStatus = useCloudSaveStatus();
  const [activeTab, setActiveTab] = useState('today');
  const [selectedContact, setSelectedContact] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Filter preset: Dashboard sets this to true when the user clicks the
  // "X stagnant contacts · View" callout, then Contacts opens pre-filtered.
  const [stagnantOnly, setStagnantOnly] = useState(false);
  const [showRestoreBanner, setShowRestoreBanner] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showTour, setShowTour] = useState(() => {
    try { return localStorage.getItem(ONBOARD_KEY) !== '1'; } catch(e) { return false; }
  });
  // Legacy local toast state removed; see global toast() from the _toastStore at top of file.
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('bloom-crm-theme');
    if (stored) return stored === 'dark';
    return false; // default to light mode; users can toggle to dark
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('bloom-crm-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const preUpdateKeys = useMemo(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_KEY + '-pre-update-')) keys.push(k);
    }
    return keys.sort().reverse();
  }, []);

  const contacts = data.contacts || [];
  const stages = data.stages || DEFAULT_STAGES;
  const cadence = data.cadence || DEFAULT_CADENCE;
  const stagnation = data.stagnation || DEFAULT_STAGNATION;
  const [lastAutoBackup, setLastAutoBackup] = useState(null);
  const [lastBackupDownload, setLastBackupDownload] = useState(() => {
    const stored = localStorage.getItem(LAST_BACKUP_DOWNLOAD_KEY);
    return stored ? new Date(stored) : null;
  });
  const backupIsStale = useMemo(() => {
    // Don't nag users who haven't added any contacts yet — nothing to back up
    if (!(data.contacts && data.contacts.length > 0)) return false;
    if (!lastBackupDownload) {
      // Grace period: if user just started, don't show warning until they've had 3 days
      const createdAt = (data.contacts[0] && data.contacts[0].createdAt) ? new Date(data.contacts[0].createdAt) : null;
      if (createdAt) {
        const daysSinceStart = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceStart < BACKUP_REMINDER_DAYS) return false;
      }
      return true;
    }
    const diffDays = (Date.now() - lastBackupDownload.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > BACKUP_REMINDER_DAYS;
  }, [lastBackupDownload, data.contacts]);

  // Save locally immediately; debounce cloud save to avoid collisions on rapid edits.
  // Skip the cloud POST entirely if the payload hasn't changed since the last
  // successful save (prevents redundant writes on harmless re-renders).
  const pendingCloudData = useRef(null);
  useEffect(() => {
    saveData(data);
    if (user && CURRENT_UID) {
      let currentJson;
      try { currentJson = JSON.stringify(data); } catch(_) { currentJson = null; }
      if (currentJson && currentJson === LAST_SAVED_PAYLOAD_JSON) {
        // Nothing changed — skip the network round-trip.
        return;
      }
      pendingCloudData.current = data;
      const handle = setTimeout(() => {
        cloudSave(data);
        pendingCloudData.current = null;
      }, 1500);
      return () => clearTimeout(handle);
    }
  }, [data]);

  // On first load, check if IDB has better data than localStorage
  useEffect(() => {
    loadDataWithIDBFallback(data).then(betterData => {
      if (betterData && betterData.contacts && betterData.contacts.length > (data.contacts || []).length) {
        setData(betterData);
        console.log('[CRM] IDB fallback provided more contacts: ' + betterData.contacts.length + ' vs ' + (data.contacts || []).length);
      }
    }).catch(e => {
      console.warn('[CRM] IDB fallback check failed:', e);
      if (window.Sentry) Sentry.captureException(e);
      // Non-fatal — keep whatever data we already have from localStorage
    });
  }, []);

  // Save to IDB + localStorage on tab close / navigate away, and flush any pending cloud save
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        const json = JSON.stringify(data);
        localStorage.setItem(STORAGE_KEY, json);
        idbSave(data);
        // Flush pending debounced cloud save using sendBeacon for reliability
        if (user && CURRENT_UID && pendingCloudData.current) {
          try {
            const body = JSON.stringify({
              user_id: CURRENT_UID,
              payload: pendingCloudData.current,
              updated_at: new Date().toISOString()
            });
            const url = SUPABASE_URL + '/rest/v1/crm_data';
            const blob = new Blob([body], { type: 'application/json' });
            // sendBeacon cannot add auth headers; fall back to sync-ish fetch keepalive
            fetch(url, {
              method: 'POST',
              headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + (CURRENT_ACCESS_TOKEN || SUPABASE_ANON_KEY),
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
              },
              body,
              keepalive: true
            }).catch(() => {});
          } catch(e) { /* best-effort */ }
        }
      } catch(e) { console.warn('[CRM] beforeunload save failed', e); }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [data, user]);

  // Detect sign-out from another tab and reload so this tab doesn't keep stale state
  useEffect(() => {
    const handleStorage = (e) => {
      if (!user) return;
      // Supabase stores session under a key like 'sb-<ref>-auth-token'
      if (e.key && e.key.startsWith('sb-') && e.key.endsWith('-auth-token') && !e.newValue) {
        window.location.reload();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [user]);

  // Auto-backup every 30 minutes
  const AUTO_BACKUP_KEY = STORAGE_KEY + '-auto-timed-';
  const MAX_AUTO_BACKUPS = 10;
  const doAutoBackup = useCallback(() => {
    try {
      const json = JSON.stringify(data);
      const key = AUTO_BACKUP_KEY + Date.now();
      localStorage.setItem(key, json);
      setLastAutoBackup(new Date());
      // Clean old auto-backups, keep only the most recent MAX_AUTO_BACKUPS
      const autoKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(AUTO_BACKUP_KEY)) autoKeys.push(k);
      }
      autoKeys.sort().reverse();
      autoKeys.slice(MAX_AUTO_BACKUPS).forEach(k => localStorage.removeItem(k));
      console.log('[CRM] Auto-backup saved (' + (data.contacts||[]).length + ' contacts)');
    } catch(e) { console.error('[CRM] Auto-backup failed', e); }
  }, [data]);

  useEffect(() => {
    doAutoBackup(); // backup on first load
    const interval = setInterval(doAutoBackup, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [doAutoBackup]);

  // Toast helper
  const showToast = useCallback((msg) => toast(msg, 'success'), []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

      // Esc always works
      if (e.key === 'Escape') {
        if (showShortcuts) { setShowShortcuts(false); return; }
        if (selectedContact) { setSelectedContact(null); return; }
        return;
      }

      // Skip shortcuts when typing in form fields
      if (inInput) return;

      if (e.key === '?') { e.preventDefault(); setShowShortcuts(s => !s); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); handleAddContact(); showToast('New contact created'); return; }
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); setDarkMode(dm => !dm); return; }
      if (e.key === '/') {
        e.preventDefault();
        const searchEl = document.querySelector('input[placeholder*="Search"]');
        if (searchEl) searchEl.focus();
        return;
      }

      // Number keys for tab switching (1-based, matching tab order)
      const num = parseInt(e.key);
      if (num >= 1 && num <= tabs.length) {
        e.preventDefault();
        setActiveTab(tabs[num - 1].id);
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showShortcuts, selectedContact]);

  const handleUpdateContact = (updated) => { setData(prev => ({...prev, contacts: prev.contacts.map(c => c.id === updated.id ? {...updated, tags: updated.tags||[]} : c)})); };
  const handleDeleteContact = (id) => { setData(prev => ({...prev, contacts: prev.contacts.filter(c => c.id !== id)})); };
  const handleUpdateStages = (newStages) => { setData(prev => ({...prev, stages: newStages})); };
  const handleRenameStage = (oldName, newName) => {
    setData(prev => {
      const nc = {...(prev.cadence||{})}; if (nc[oldName] !== undefined) { nc[newName] = nc[oldName]; delete nc[oldName]; }
      return {...prev, stages: (prev.stages||DEFAULT_STAGES).map(s => s===oldName?newName:s), contacts: prev.contacts.map(c => c.stage===oldName?{...c,stage:newName}:c), cadence: nc};
    });
  };
  const handleUpdateCadence = (nc) => {
    setData(prev => {
      const oldCad = prev.cadence || DEFAULT_CADENCE;
      const changedStages = Object.keys(nc).filter(s => nc[s] !== oldCad[s]);
      if (changedStages.length === 0) return {...prev, cadence: nc};
      const updatedContacts = (prev.contacts || []).map(c => {
        if (changedStages.includes(c.stage)) {
          const baseDate = c.lastContactDate || today();
          return {...c, nextFollowUp: calculateNextFollowUp(c.stage, nc, baseDate)};
        }
        return c;
      });
      return {...prev, cadence: nc, contacts: updatedContacts};
    });
  };
  const handleUpdateStagnation = (ns) => {
    setData(prev => ({...prev, stagnation: ns}));
  };
  const handleBatchImport = (nc) => { setData(prev => ({...prev, contacts: [...prev.contacts, ...nc]})); };
  const handleExport = () => exportContactsToCSV(contacts);
  const handleRestoreFromBackup = () => {
    try {
      const b = localStorage.getItem(BACKUP_KEY);
      if (!b) { toast('No auto-backup found', 'warn'); return; }
      const restored = migrateData(JSON.parse(b));
      const freshData = getDefaultData();
      const existingIds = new Set((restored.contacts || []).map(c => c.id));
      const existingNames = new Set((restored.contacts || []).map(c => c.name.toLowerCase().trim()));
      const newContacts = (freshData.contacts || []).filter(c => !existingIds.has(c.id) && !existingNames.has(c.name.toLowerCase().trim()));
      const mergedStages = [...new Set([...(restored.stages || []), ...(freshData.stages || [])])];
      const mergedCadence = {...(freshData.cadence || {}), ...(restored.cadence || {})};
      const merged = {...restored, contacts: [...restored.contacts, ...newContacts], stages: mergedStages, cadence: mergedCadence};
      setData(merged);
      toast('Restored ' + restored.contacts.length + ' contacts + ' + newContacts.length + ' new', 'success');
    } catch(e) { toast('Restore failed: ' + e.message, 'error'); }
  };
  const handleDownloadJSON = () => { const j = JSON.stringify(data, null, 2); const b = new Blob([j], {type:'application/json'}); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href=u; a.download='crm-backup-'+today()+'.json'; a.click(); URL.revokeObjectURL(u); localStorage.setItem(LAST_BACKUP_DOWNLOAD_KEY, new Date().toISOString()); setLastBackupDownload(new Date()); };
  const handleRestoreFromFile = (content) => { try { const r = migrateData(JSON.parse(content)); setData(r); toast('Restored ' + r.contacts.length + ' contacts', 'success'); } catch(e) { toast('Restore failed: ' + e.message, 'error'); }};
  const handleRestorePreUpdate = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) { toast('Backup key not found', 'warn'); return; }
      const restored = migrateData(JSON.parse(raw));
      const freshData = getDefaultData();
      const existingIds = new Set((restored.contacts || []).map(c => c.id));
      const existingNames = new Set((restored.contacts || []).map(c => c.name.toLowerCase().trim()));
      const newContacts = (freshData.contacts || []).filter(c => !existingIds.has(c.id) && !existingNames.has(c.name.toLowerCase().trim()));
      const mergedStages = [...new Set([...(restored.stages || []), ...(freshData.stages || [])])];
      const mergedCadence = {...(freshData.cadence || {}), ...(restored.cadence || {})};
      const merged = {...restored, contacts: [...restored.contacts, ...newContacts], stages: mergedStages, cadence: mergedCadence};
      setData(merged);
      localStorage.setItem(MASTER_VERSION_KEY, MASTER_DATA_VERSION);
      toast('Restored ' + restored.contacts.length + ' + merged ' + newContacts.length + ' (total ' + merged.contacts.length + ')', 'success');
    } catch(e) { toast('Restore failed: ' + e.message, 'error'); }
  };
  const handleAddContact = () => {
    const nc = { id: Math.random().toString(36).substr(2,9), name: '', company: '', stage: stages[0], email: '', phone: '', source: 'Direct',
      dealValue: 0, monthlyRevenue: 0, priority: 'medium', lastContactDate: today(), nextFollowUp: calculateNextFollowUp(stages[0], cadence),
      notes: '', tags: [], interactions: [], notesTimeline: [], createdAt: new Date().toISOString(), stageChangedAt: new Date().toISOString() };
    setData(prev => ({...prev, contacts: [nc, ...prev.contacts]}));
    setSelectedContact(nc);
    // Focus the name input after the detail panel animates in
    setTimeout(() => {
      const nameInput = document.querySelector('.detail-panel input[type="text"]');
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    }, 200);
  };

  const tabs = [
    { id: 'today', label: 'Today', icon: <Icon name="sun" size={16} /> },
    { id: 'dashboard', label: 'Dashboard', icon: <Icon name="dashboard" size={16} /> },
    { id: 'contacts', label: 'Contacts', icon: <Icon name="users" size={16} /> },
    { id: 'deals', label: 'Deals', icon: <Icon name="dollar" size={16} /> },
    { id: 'followups', label: 'Follow-ups', icon: <Icon name="phone" size={16} /> },
    { id: 'digest', label: 'Weekly Digest', icon: <Icon name="clipboard" size={16} /> },
    { id: 'roi', label: 'Source ROI', icon: <Icon name="chart" size={16} /> },
    { id: 'import', label: 'Import', icon: <Icon name="upload" size={16} /> },
    { id: 'settings', label: 'Settings', icon: <Icon name="settings" size={16} /> }
  ];

  // Global empty-state CTA for first-time users with no contacts yet (on contact-centric tabs)
  const emptyTabs = ['today','dashboard','contacts','deals','followups','digest','roi'];
  const showEmpty = contacts.length === 0 && emptyTabs.includes(activeTab);

  const renderContent = () => {
    if (showEmpty) {
      return (
        <EmptyState
          icon={<Icon name="userplus" size={32} />}
          title="Add your first contact to get started"
          body="InnerGame CRM is empty. Add a person you want to track, or import an existing list from CSV. The Dashboard and pipeline views will fill in once you have contacts."
          ctaLabel="+ Add first contact"
          onCta={handleAddContact}
          secondaryLabel="Import from CSV"
          onSecondary={() => setActiveTab('import')}
        />
      );
    }
    switch (activeTab) {
      case 'today': return <TodayView contacts={contacts} stages={stages} onSelectContact={setSelectedContact} onUpdateContact={handleUpdateContact} cadence={cadence} user={user} />;
      case 'dashboard': return <DashboardView contacts={contacts} stages={stages} stagnation={stagnation} onShowStagnant={() => { setStagnantOnly(true); setActiveTab('contacts'); }} />;
      case 'contacts': return <ContactsView contacts={contacts} onSelectContact={setSelectedContact} onUpdateContact={handleUpdateContact} onDeleteContact={handleDeleteContact} stages={stages} cadence={cadence} stagnation={stagnation} stagnantOnly={stagnantOnly} onClearStagnant={() => setStagnantOnly(false)} />;
      case 'deals': return <DealsView contacts={contacts} stages={stages} />;
      case 'followups': return <FollowUpsView contacts={contacts} stages={stages} onSelectContact={setSelectedContact} onUpdateContact={handleUpdateContact} cadence={cadence} />;
      case 'digest': return <WeeklyDigestView contacts={contacts} stages={stages} />;
      case 'roi': return <SourceROIView contacts={contacts} />;
      case 'import': return <CSVImportView stages={stages} onImport={handleBatchImport} />;
      case 'settings': return <SettingsView stages={stages} onUpdateStages={handleUpdateStages} onRenameStage={handleRenameStage} cadence={cadence} onUpdateCadence={handleUpdateCadence} stagnation={stagnation} onUpdateStagnation={handleUpdateStagnation} contacts={contacts} onExport={handleExport} onRestoreBackup={handleRestoreFromBackup} onDownloadJSON={handleDownloadJSON} onRestoreFile={handleRestoreFromFile} onRestorePreUpdate={handleRestorePreUpdate} />;
      default: return <DashboardView contacts={contacts} stages={stages} stagnation={stagnation} onShowStagnant={() => { setStagnantOnly(true); setActiveTab('contacts'); }} />;
    }
  };

  return (
    <div className="flex h-screen" style={{background: 'var(--bg-primary)', color: 'var(--text-primary)'}}>
      <div className={'desktop-sidebar ' + (sidebarOpen ? 'w-56' : 'w-0') + ' border-r flex-shrink-0 transition-all overflow-hidden'} style={{background: 'var(--sidebar-bg)'}}>
        <div className="p-4 border-b flex items-center">
          <img src={darkMode ? 'logo-mark.png' : 'logo.png'} alt="InnerGame CRM" style={{maxWidth: darkMode ? '130px' : '160px', width: '100%', height: 'auto', display: 'block'}} />
        </div>
        <nav className="p-3 space-y-1">{tabs.map(tab => (
          <div key={tab.id} className={'sidebar-item text-sm ' + (activeTab === tab.id ? 'active' : '')} onClick={() => setActiveTab(tab.id)}>
            <span>{tab.icon}</span><span>{tab.label}</span>
          </div>
        ))}</nav>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="desktop-topbar border-b px-4 py-3 flex items-center gap-3" style={{background: 'var(--topbar-bg)'}}>
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-gray-400 hover:text-gray-600" title="Toggle sidebar"><Icon name="menu" size={20} /></button>
          <div className="flex-1" />
          {lastAutoBackup && <span className="backup-text text-xs text-gray-400 flex items-center gap-1" title="Auto-backup runs every 30 minutes"><Icon name="save" size={13} /> Backed up {lastAutoBackup.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>}
          <button onClick={() => { doAutoBackup(); toast('Backup saved', 'success'); }} className="backup-text text-xs text-gray-400 hover:text-blue-500 cursor-pointer" title="Save backup now"><Icon name="refresh" size={14} /></button>
          <button onClick={handleDownloadJSON} className={"px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 " + (backupIsStale ? "bg-amber-500 text-white hover:bg-amber-600" : "")} style={backupIsStale ? {} : {background: 'var(--bg-tertiary)', color: 'var(--text-secondary)'}} title={lastBackupDownload ? "Last downloaded: " + lastBackupDownload.toLocaleDateString() : "Never downloaded a backup"}>
            {backupIsStale ? <Icon name="alert" size={14} /> : <Icon name="download" size={14} />} Backup
          </button>
          {CURRENT_UID && cloudStatus === 'saving' && <span className="sync-badge sync-saving flex items-center gap-1"><Icon name="refresh" size={11} /> Saving...</span>}
          {CURRENT_UID && cloudStatus === 'error' && <button onClick={() => cloudSave(data)} className="sync-badge sync-error flex items-center gap-1" title="Sync failed — click to retry"><Icon name="alert" size={11} /> Sync failed</button>}
          {CURRENT_UID && (cloudStatus === 'saved' || cloudStatus === 'idle') && <span className="sync-badge sync-online flex items-center gap-1"><Icon name="cloud" size={11} /> Synced</span>}
          <button onClick={() => setDarkMode(d => !d)} className="theme-toggle" title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} />
          <button onClick={() => setShowShortcuts(true)} className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer" title="Keyboard shortcuts"><span className="kbd">?</span></button>
          <button onClick={handleAddContact} className="px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90 flex items-center gap-1.5" style={{background: 'var(--accent)'}}>
            <Icon name="plus" size={15} /> Add
          </button>
          <button onClick={async () => {
              const ok = await confirmDialog({
                title: 'Sign out?',
                body: 'Your data stays saved in the cloud \u2014 you can sign back in from any device.',
                confirmLabel: 'Sign out',
              });
              if (!ok) return;
              // Clear per-user localStorage & IDB so no trace remains for the next user of this browser
              try {
                const keysToRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  if (k && (k.startsWith('bloom-crm-' + CURRENT_UID + '-') || k.startsWith('bloom-crm-anonymous-'))) keysToRemove.push(k);
                }
                keysToRemove.forEach(k => localStorage.removeItem(k));
                if (window.indexedDB && IDB_NAME) { indexedDB.deleteDatabase(IDB_NAME); }
              } catch(e) { console.warn('[CRM] Signout cleanup failed:', e); }
              _sb.auth.signOut().finally(() => window.location.reload());
            }}
            className="flex items-center gap-1" title="Sign out">
            <span className="w-7 h-7 rounded-full text-xs font-bold text-white" style={{background: 'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center'}}>{(user && user.user_metadata?.display_name ? user.user_metadata.display_name[0] : user && user.email ? user.email[0] : 'U').toUpperCase()}</span>
          </button>
        </div>
        {backupIsStale && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-3" style={{zIndex:39}}>
            <span className="text-amber-600 flex-shrink-0"><Icon name="alert" size={18} /></span>
            <span className="text-sm text-amber-800 flex-1">
              {lastBackupDownload
                ? 'Your last backup download was ' + Math.floor((Date.now() - lastBackupDownload.getTime()) / (1000*60*60*24)) + ' days ago. Download a fresh backup to protect your data.'
                : 'You have never downloaded a backup. Your data only exists in this browser\u2019s localStorage and can be lost if browser data is cleared.'}
            </span>
            <button onClick={handleDownloadJSON} className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 flex-shrink-0">Download Now</button>
          </div>
        )}
        {showRestoreBanner && preUpdateKeys.length > 0 && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-3" style={{zIndex:40}}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <span className="text-amber-600 flex-shrink-0"><Icon name="alert" size={20} /></span>
                <span className="font-medium text-amber-800 text-sm">Pre-update backups found — select one to restore your check-ins:</span>
              </div>
              <button onClick={() => setShowRestoreBanner(false)} className="text-amber-400 hover:text-amber-600 text-xl leading-none flex-shrink-0">{'\u00D7'}</button>
            </div>
            <div className="space-y-2 ml-7">
              {preUpdateKeys.map((k, i) => {
                const ts = parseInt(k.split('-pre-update-')[1]);
                const dateStr = ts ? new Date(ts).toLocaleString() : 'Unknown time';
                return (
                  <div key={k} className="flex items-center justify-between bg-white rounded-lg p-2 border border-amber-200">
                    <span className="text-sm text-gray-700">{dateStr}{i === 0 ? ' (most recent)' : ''}</span>
                    <button onClick={() => { handleRestorePreUpdate(k); setShowRestoreBanner(false); }} className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 cursor-pointer">Restore This Backup</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          <div className="main-content flex-1 overflow-y-auto p-6">
            {renderContent()}
            <div className="app-footer text-center text-xs mt-8 pt-4 pb-2" style={{color: 'var(--text-tertiary)', borderTop: '1px solid var(--border-light)'}}>
              Developed by InnerGame Consulting
            </div>
          </div>
          {selectedContact && <ContactDetail contact={selectedContact} onClose={() => setSelectedContact(null)} onUpdate={handleUpdateContact} stages={stages} onDelete={handleDeleteContact} cadence={cadence} />}
        </div>
      </div>
      {/* Mobile bottom nav */}
      <div className="mobile-bottom-nav">
        <div className="flex justify-around w-full">
          {tabs.slice(0, 5).map(tab => (
            <div key={tab.id} className={'mobile-tab ' + (activeTab === tab.id ? 'active' : '')} onClick={() => setActiveTab(tab.id)}>
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </div>
          ))}
          <div className={'mobile-tab ' + (['digest','roi','import','settings'].includes(activeTab) || mobileMoreOpen ? 'active' : '')} onClick={() => setMobileMoreOpen(v => !v)}>
            <span><Icon name="menu" size={18} /></span>
            <span>More</span>
          </div>
        </div>
      </div>
      {/* Mobile "More" sheet */}
      {mobileMoreOpen && (
        <div className="mobile-more-overlay" onClick={() => setMobileMoreOpen(false)}>
          <div className="mobile-more-sheet" onClick={e => e.stopPropagation()}>
            <div className="mobile-more-handle"></div>
            <div className="text-xs font-semibold mb-2" style={{color:'var(--text-tertiary)',textTransform:'uppercase',letterSpacing:'0.05em'}}>More views</div>
            {tabs.slice(5).map(tab => (
              <div key={tab.id} className={'mobile-more-item ' + (activeTab === tab.id ? 'active' : '')}
                   onClick={() => { setActiveTab(tab.id); setMobileMoreOpen(false); }}>
                <span style={{fontSize:'18px'}}>{tab.icon}</span>
                <span>{tab.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Keyboard shortcut cheat sheet */}
      {showShortcuts && (
        <div className="shortcut-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="rounded-xl shadow-2xl w-full max-w-md p-6" style={{background: 'var(--bg-secondary)'}} onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold" style={{color: 'var(--text-primary)'}}>Keyboard Shortcuts</h2>
              <button onClick={() => setShowShortcuts(false)} className="text-gray-400 hover:text-gray-600 text-2xl">{'\u00D7'}</button>
            </div>
            <div className="space-y-3">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Navigation</div>
              {tabs.map((tab, i) => (
                <div key={tab.id} className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">{tab.icon} {tab.label}</span>
                  <span className="kbd">{i + 1}</span>
                </div>
              ))}
              <hr className="border-gray-100" />
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Actions</div>
              <div className="flex items-center justify-between"><span className="text-sm text-gray-700">New contact</span><span className="kbd">N</span></div>
              <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Focus search</span><span className="kbd">/</span></div>
              <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Toggle dark mode</span><span className="kbd">D</span></div>
              <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Close panel</span><span className="kbd">Esc</span></div>
              <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Show this help</span><span className="kbd">?</span></div>
            </div>
          </div>
        </div>
      )}
      {/* Toast notifications are rendered globally via <ToastContainer /> at root */}
      {showTour && <OnboardingTour onDone={() => setShowTour(false)} />}
    </div>
  );
};

// ─── Toast container (renders all active toasts) ───
const ToastContainer = () => {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  const iconFor = (k) => k === 'success' ? '\u2713' : k === 'error' ? '\u2715' : k === 'warn' ? '!' : 'i';
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={'toast toast-' + t.kind}>
          <span className="toast-icon">{iconFor(t.kind)}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Confirm dialog host ───
const ConfirmHost = () => {
  const state = useConfirm();
  // Close on Escape
  useEffect(() => {
    if (!state) return;
    const onKey = (e) => { if (e.key === 'Escape') _closeConfirm(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);
  if (!state) return null;
  return (
    <div className="confirm-overlay" onClick={() => _closeConfirm(false)}>
      <div className="confirm-card" onClick={e => e.stopPropagation()}>
        <div className="confirm-title">{state.title}</div>
        {state.body && <div className="confirm-body">{state.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="confirm-btn confirm-btn-cancel" onClick={() => _closeConfirm(false)}>{state.cancelLabel}</button>
          <button type="button" className={'confirm-btn ' + (state.danger ? 'confirm-btn-danger' : 'confirm-btn-ok')} onClick={() => _closeConfirm(true)} autoFocus>{state.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

// ─── Onboarding tour (first-time users) ───
const ONBOARD_KEY = 'bloom-crm-onboarded';
const ONBOARD_STEPS = [
  { title: 'Welcome to InnerGame CRM', body: 'Let\u2019s take 30 seconds to get oriented. You can always skip and come back later.' },
  { title: 'Start in Today', body: 'The Today tab shows who needs attention right now \u2014 overdue follow-ups, today\u2019s tasks, and stale contacts. Start every day here.' },
  { title: 'Contacts are your foundation', body: 'Add people you want to track. Drag them through pipeline stages, log notes, and the CRM will remind you when to follow up.' },
  { title: 'Deals and reports', body: 'When money is involved, the Deals view shows your pipeline by value. Open the More menu on mobile to find Weekly Digest and Source ROI.' },
  { title: 'You\u2019re ready', body: 'Press "?" anytime for keyboard shortcuts. Back up your data from Settings. Let\u2019s go.' }
];
const OnboardingTour = ({ onDone }) => {
  const [step, setStep] = useState(0);
  const cur = ONBOARD_STEPS[step];
  const last = step === ONBOARD_STEPS.length - 1;
  const finish = () => { try { localStorage.setItem(ONBOARD_KEY, '1'); } catch(e) {} onDone(); };
  return (
    <>
      <div className="tour-backdrop" onClick={finish} />
      <div className="tour-card" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
        <div className="tour-step">Step {step + 1} of {ONBOARD_STEPS.length}</div>
        <h3 className="tour-title">{cur.title}</h3>
        <p className="tour-body">{cur.body}</p>
        <div className="tour-actions">
          <button className="tour-skip" onClick={finish}>Skip tour</button>
          <button className="tour-next" onClick={() => last ? finish() : setStep(step + 1)}>{last ? 'Get started' : 'Next'}</button>
        </div>
      </div>
    </>
  );
};

// ─── Empty state (reusable) ───
const EmptyState = ({ icon, title, body, ctaLabel, onCta, secondaryLabel, onSecondary }) => (
  <div className="empty-state">
    <div className="empty-state-icon">{icon}</div>
    <h3 className="empty-state-title">{title}</h3>
    <p className="empty-state-body">{body}</p>
    <div className="empty-state-actions">
      {onCta && <button className="empty-state-cta" onClick={onCta}>{ctaLabel}</button>}
      {onSecondary && <button className="empty-state-secondary" onClick={onSecondary}>{secondaryLabel}</button>}
    </div>
  </div>
);

// ─── Skeleton loading states ───
const SkeletonStats = () => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    {[0,1,2,3].map(i => (
      <div key={i} className="skeleton-card">
        <div className="skeleton skeleton-text" style={{width:'60%'}} />
        <div className="skeleton skeleton-title" style={{width:'40%',marginTop:8}} />
      </div>
    ))}
  </div>
);
const SkeletonList = ({ rows = 5 }) => (
  <div className="space-y-2">
    {Array.from({length: rows}).map((_, i) => (
      <div key={i} className="skeleton-card" style={{display:'flex',alignItems:'center',gap:12}}>
        <div className="skeleton" style={{width:36,height:36,borderRadius:'50%',flexShrink:0}} />
        <div style={{flex:1}}>
          <div className="skeleton skeleton-text" style={{width:'45%'}} />
          <div className="skeleton skeleton-text" style={{width:'30%',marginTop:4}} />
        </div>
      </div>
    ))}
  </div>
);

// Full-app skeleton shown after login while cloud data is loading —
// looks like the real layout so the transition feels smooth.
const AppSkeleton = () => (
  <div className="flex h-screen" style={{background:'var(--bg-primary)',color:'var(--text-primary)'}}>
    <div className="desktop-sidebar w-56 border-r flex-shrink-0" style={{background:'var(--sidebar-bg)'}}>
      <div className="p-4 border-b"><div className="skeleton" style={{height:18,width:'70%'}} /></div>
      <div className="p-3 space-y-1">
        {Array.from({length:6}).map((_,i) => (
          <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px'}}>
            <div className="skeleton" style={{width:16,height:16,borderRadius:4}} />
            <div className="skeleton" style={{height:12,width:80 + (i%3)*20}} />
          </div>
        ))}
      </div>
    </div>
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b px-4 py-3 flex items-center gap-3" style={{background:'var(--topbar-bg)',minHeight:56}}>
        <div className="skeleton" style={{width:20,height:20,borderRadius:4}} />
        <div className="flex-1" />
        <div className="skeleton" style={{width:70,height:22,borderRadius:999}} />
        <div className="skeleton" style={{width:28,height:28,borderRadius:999}} />
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <SkeletonStats />
        <div className="skeleton-card mb-4">
          <div className="skeleton skeleton-title" style={{width:'30%'}} />
          <div style={{marginTop:16}}><SkeletonList rows={4} /></div>
        </div>
      </div>
    </div>
  </div>
);

// ─── SVG icon set (replaces emojis so they render identically across platforms) ───
// Stroke-based icons in lucide style. Each returns a span so callers can style size via fontSize.
const Icon = ({ name, size = 18, className = '', style = {} }) => {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const paths = {
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></>,
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    dollar: <><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
    phone: <><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13 1.05.37 2.07.72 3.06a2 2 0 0 1-.45 2.11L8.09 10.2a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.99.35 2.01.59 3.06.72A2 2 0 0 1 22 16.92z"/></>,
    clipboard: <><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M8 12h8M8 16h5"/></>,
    chart: <><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></>,
    alert: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><path d="M12 15V3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    menu: <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    userplus: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><path d="M12 3v12"/></>,
    mail: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></>,
    edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    cloud: <><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></>,
    cloudOff: <><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/></>,
    refresh: <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></>,
    trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
    help: <><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    dot: <><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/></>,
    sparkles: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/></>,
  };
  return (
    <span className={className} style={{display:'inline-flex',alignItems:'center',justifyContent:'center',...style}} aria-hidden="true">
      <svg {...common}>{paths[name] || paths.clipboard}</svg>
    </span>
  );
};

// ─── Error Boundary (prevents one broken component from blanking the whole app) ───
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, err: null }; }
  static getDerivedStateFromError(err) { return { hasError: true, err }; }
  componentDidCatch(err, info) {
    console.error('[CRM] React error:', err, info);
    // Report to Sentry if available
    if (window.Sentry) {
      Sentry.withScope(scope => {
        scope.setExtras({ componentStack: info && info.componentStack });
        scope.setTag('error_boundary', 'root');
        Sentry.captureException(err);
      });
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px',background:'var(--bg-primary)',color:'var(--text-primary)'}}>
          <div style={{maxWidth:'500px',textAlign:'center',background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:'16px',padding:'40px'}}>
            <div style={{fontSize:'48px',marginBottom:'16px'}}>{'\u26A0\uFE0F'}</div>
            <h1 style={{fontSize:'20px',fontWeight:700,marginBottom:'12px'}}>Something went wrong</h1>
            <p style={{fontSize:'14px',color:'var(--text-secondary)',marginBottom:'20px'}}>Your data is safe. Please reload the page to continue.</p>
            <div style={{fontSize:'11px',color:'var(--text-tertiary)',marginBottom:'20px',fontFamily:'monospace',wordBreak:'break-word'}}>{this.state.err && this.state.err.message}</div>
            <button onClick={() => window.location.reload()} style={{padding:'12px 24px',background:'var(--accent)',color:'white',border:'none',borderRadius:'8px',fontWeight:600,cursor:'pointer'}}>Reload app</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.render(
  <ErrorBoundary>
    <AppWrapper />
    <ToastContainer />
    <ConfirmHost />
  </ErrorBoundary>,
  document.getElementById('root')
);
