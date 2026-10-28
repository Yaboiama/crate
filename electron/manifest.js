// queue.json in userData — the contract. If a row exists, that track is owed
// to the user. Atomic writes (tmp + rename), debounced ~250ms, saved on every
// state change. Rows are never auto-deleted; only the user clears them.
'use strict';

const fs = require('fs');
const path = require('path');

let file = null;
let data = { batches: [], rows: [] };
let saveTimer = null;
const listeners = []; // fn(type, payload) — type: 'rows' | 'row'

let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function init(userDataPath) {
  file = path.join(userDataPath, 'queue.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.rows)) data = { batches: raw.batches || [], rows: raw.rows };
  } catch {
    data = { batches: [], rows: [] };
  }
}

function saveNow() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file); // crash mid-write can never corrupt the manifest
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 250);
}

function emit(type, payload) {
  for (const fn of listeners) { try { fn(type, payload); } catch { /* ignore */ } }
}

function onChange(fn) { listeners.push(fn); }

function rows() { return data.rows; }
function batches() { return data.batches; }
function getRow(id) { return data.rows.find((r) => r.id === id) || null; }

function makeRow(fields) {
  return {
    id: newId('r'),
    batchId: null,
    addedAt: Date.now(),
    sourceKind: null,      // 'youtube' | 'soundcloud' | 'spotify' | 'other'
    sourceUrl: null,       // direct media page URL once known
    sourceTitle: null,     // raw title from the source — a search hint only
    sourceUploader: null,
    sourceThumb: null,
    sourceDurationSec: null,
    needsResolve: false,   // spotify rows: audio location not yet known
    status: 'pending',     // loaded | pending | working | done | failed | skipped
    stage: null,           // resolve | match | download | convert | art | tag | place
    progress: 0,
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    note: null,
    meta: null,            // matched release metadata
    matched: false,
    matchMode: null,       // 'matched' | 'source' | 'blank'
    matchScore: null,
    tagged: false,
    artPath: null,
    destDir: null,        // set when the row belongs to a watched playlist
    destPath: null,
    filePath: null,
    ...fields,
  };
}

function addBatch(batch, newRows) {
  const b = { id: newId('b'), addedAt: Date.now(), ...batch };
  for (const r of newRows) r.batchId = b.id;
  data.batches.push(b);
  data.rows.push(...newRows);
  save();
  emit('rows', data.rows);
  return b;
}

function update(id, patch) {
  const row = getRow(id);
  if (!row) return null;
  Object.assign(row, patch);
  save();
  emit('row', row);
  return row;
}

// App died mid-download: anything left `working` goes back to `pending`.
function resetWorking() {
  let n = 0;
  for (const r of data.rows) {
    if (r.status === 'working') {
      r.status = 'pending';
      r.stage = null;
      r.progress = 0;
      r.note = 'Resumed after restart';
      n += 1;
    }
  }
  if (n) { save(); emit('rows', data.rows); }
  return n;
}

// Download pressed: everything sitting in `loaded` joins the queue.
function startLoaded() {
  let n = 0;
  for (const r of data.rows) {
    if (r.status === 'loaded') {
      Object.assign(r, { status: 'pending', nextAttemptAt: 0, note: null });
      n += 1;
    }
  }
  if (n) { save(); emit('rows', data.rows); }
  return n;
}

function retryRow(id) {
  const r = getRow(id);
  if (!r || (r.status !== 'failed' && r.status !== 'skipped')) return;
  Object.assign(r, { status: 'pending', attempts: 0, nextAttemptAt: 0, error: null, note: null, stage: null, progress: 0 });
  save();
  emit('row', r);
}

function retryFailed() {
  let n = 0;
  for (const r of data.rows) {
    if (r.status === 'failed') {
      Object.assign(r, { status: 'pending', attempts: 0, nextAttemptAt: 0, error: null, note: null, stage: null, progress: 0 });
      n += 1;
    }
  }
  if (n) { save(); emit('rows', data.rows); }
  return n;
}

function removeRow(id) {
  const i = data.rows.findIndex((r) => r.id === id);
  if (i === -1) return;
  data.rows.splice(i, 1);
  save();
  emit('rows', data.rows);
}

function clearFinished() {
  const before = data.rows.length;
  data.rows = data.rows.filter((r) => r.status !== 'done' && r.status !== 'skipped');
  const liveBatches = new Set(data.rows.map((r) => r.batchId));
  data.batches = data.batches.filter((b) => liveBatches.has(b.id));
  if (data.rows.length !== before) { save(); emit('rows', data.rows); }
  return before - data.rows.length;
}

// Drops everything waiting to be started. Only touches `loaded` rows, so
// anything in flight, finished or failed is left exactly as it is.
function clearLoaded() {
  const before = data.rows.length;
  data.rows = data.rows.filter((r) => r.status !== 'loaded');
  const liveBatches = new Set(data.rows.map((r) => r.batchId));
  data.batches = data.batches.filter((b) => liveBatches.has(b.id));
  if (data.rows.length !== before) { save(); emit('rows', data.rows); }
  return before - data.rows.length;
}

function counts() {
  const c = { total: data.rows.length, loaded: 0, pending: 0, working: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of data.rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

module.exports = {
  init, rows, batches, getRow, makeRow, addBatch, update,
  resetWorking, startLoaded, retryRow, retryFailed, removeRow, clearFinished, clearLoaded,
  counts, saveNow, onChange,
};
