'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('settings:get'),
  saveSettings: call('settings:save'),
  pickFile: call('files:pick'),
  // folders
  addFolder: call('folders:add'),
  removeFolder: call('folders:remove'),
  setBrainDir: call('brain:set'),
  clearBrainDir: call('brain:clear'),
  setDbDir: call('db:set'),
  resetDbDir: call('db:reset'),
  // servers
  startServer: call('servers:start'),
  stopServer: call('servers:stop'),
  // indexing
  runIndex: call('index:run'),
  cancelIndex: call('index:cancel'),
  clearIndex: call('index:clear'),
  ocrStatus: call('ocr:status'),
  // optional dependencies
  getDeps: call('deps:status'),
  installDeps: call('deps:install'),
  // memory
  listMemories: call('memory:list'),
  addMemory: call('memory:add'),
  deleteMemory: call('memory:delete'),
  clearMemories: call('memory:clear'),
  // evaluation
  runEval: call('eval:run'),
  // chat
  ask: (question, history) => ipcRenderer.invoke('chat:ask', { question, history }),
  cancelChat: call('chat:cancel'),
  revealFile: call('open:path'),
  // events
  onLog: on('log'),
  onDepsProgress: on('deps-progress'),
  onIndexProgress: on('index-progress'),
  onIndexDone: on('index-done'),
  onIndexError: on('index-error'),
  onEvalProgress: on('eval-progress'),
  onDelta: on('chat-delta'),
  onSources: on('chat-sources'),
  onWarn: on('chat-warn'),
  onMemoryChanged: on('memory-changed'),
  onServersStatus: on('servers-status'),
});
