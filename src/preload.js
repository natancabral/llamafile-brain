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
  getMemory: call('sys:memory'),
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
  ask: (question, conversationId) => ipcRenderer.invoke('chat:ask', { question, conversationId }),
  chatsState: call('chats:state'),
  getChat: call('chats:get'),
  renameChat: call('chats:rename'),
  deleteChat: call('chats:delete'),
  deleteAllChats: call('chats:deleteAll'),
  selectProfile: call('profiles:select'),
  createProfile: call('profiles:create'),
  updateProfile: call('profiles:update'),
  deleteProfile: call('profiles:delete'),
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
  onStatsChanged: on('stats-changed'),
  onChatsChanged: on('chats-changed'),
});
