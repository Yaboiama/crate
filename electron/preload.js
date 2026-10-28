// The IPC contract. The renderer is built against these channel names and
// event shapes — keep them stable.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('crate', {
  // queue
  expandLink: (url) => ipcRenderer.invoke('link:expand', url),
  getQueue: () => ipcRenderer.invoke('queue:get'),
  startDownloads: () => ipcRenderer.invoke('queue:start'),
  retryRow: (id) => ipcRenderer.invoke('queue:retry-row', id),
  retryFailed: () => ipcRenderer.invoke('queue:retry-failed'),
  removeRow: (id) => ipcRenderer.invoke('queue:remove-row', id),
  clearFinished: () => ipcRenderer.invoke('queue:clear-finished'),
  setPaused: (v) => ipcRenderer.invoke('engine:set-paused', v),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),

  // watched playlists
  listPlaylists: () => ipcRenderer.invoke('playlists:list'),
  addPlaylist: (payload) => ipcRenderer.invoke('playlists:add', payload),
  updatePlaylist: (payload) => ipcRenderer.invoke('playlists:update', payload),
  renamePlaylist: (payload) => ipcRenderer.invoke('playlists:rename', payload),
  removePlaylist: (id) => ipcRenderer.invoke('playlists:remove', id),
  setPlaylistCompare: (payload) => ipcRenderer.invoke('playlists:set-compare', payload),
  checkPlaylist: (id) => ipcRenderer.invoke('playlists:check', id),
  downloadNew: (id) => ipcRenderer.invoke('playlists:download-new', id),

  // spotify account
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),

  // tools
  checkTools: () => ipcRenderer.invoke('tools:check'),
  updateYtdlp: () => ipcRenderer.invoke('tools:update-ytdlp'),
  downloadYtdlp: () => ipcRenderer.invoke('tools:download-ytdlp'),

  // shell
  showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),

  // window
  winControl: (action) => ipcRenderer.invoke('win:control', action),

  // events
  onRows: (cb) => on('rows:changed', cb),
  onRow: (cb) => on('row:changed', cb),
  onStatus: (cb) => on('status', cb),
  onNotice: (cb) => on('notice', cb),
  onWinState: (cb) => on('win:state', cb),
});
