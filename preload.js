const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 面板控制
  togglePanel: () => ipcRenderer.invoke('toggle-panel'),
  forceCollapse: () => ipcRenderer.invoke('force-collapse'),
  moveWindow: (deltaX, deltaY) => ipcRenderer.send('move-window', { deltaX, deltaY }),
  onPanelState: (callback) => ipcRenderer.on('panel-state', (_, state) => callback(state)),

  // 工具
  screenshot: () => ipcRenderer.invoke('screenshot'),
  pickColor: () => ipcRenderer.invoke('pick-color'),
  openNotepad: () => ipcRenderer.invoke('open-notepad'),
  openCalculator: () => ipcRenderer.invoke('open-calculator'),
  openTranslator: () => ipcRenderer.invoke('open-translator'),
  translate: (q, from, to) => ipcRenderer.invoke('translate-text', q, from, to),
  openFileFilter: () => ipcRenderer.invoke('open-file-filter'),
  openSpreadsheet: () => ipcRenderer.invoke('open-spreadsheet'),
  openTimestamp: () => ipcRenderer.invoke('open-timestamp'),
  openJsonViewer: () => ipcRenderer.invoke('open-json-viewer'),
  openClipboard: () => ipcRenderer.invoke('open-clipboard'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  filterFiles: (dir, startDate, endDate) => ipcRenderer.invoke('filter-files', dir, startDate, endDate),
  copyFiles: (files, dest) => ipcRenderer.invoke('copy-files', files, dest),
  systemInfo: () => ipcRenderer.invoke('system-info'),

  // 取色器/截图窗口专用
  onPickerScreenshot: (cb) => ipcRenderer.on('picker-screenshot', (_, data, bx, by, ww, wh) => cb(data, bx, by, ww, wh)),
  onScreenshotData: (cb) => ipcRenderer.on('screenshot-data', (_, data) => cb(data)),
  sendColor: (color) => ipcRenderer.send('color-picked', color),
  cancelColor: () => ipcRenderer.send('color-cancel'),
  sendCropDone: (rect) => ipcRenderer.send('crop-done', rect),
  sendCropCancel: () => ipcRenderer.send('crop-cancel'),

  // 剪贴板
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  writeClipboardImage: (dataUrl) => ipcRenderer.invoke('write-clipboard-image', dataUrl),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  getClipboardHistory: () => ipcRenderer.invoke('get-clipboard-history'),
  clearClipboardHistory: () => ipcRenderer.invoke('clear-clipboard-history'),
  deleteClipboardItem: (index) => ipcRenderer.invoke('delete-clipboard-item', index),
  onClipboardUpdated: (callback) => ipcRenderer.on('clipboard-updated', (_, msg) => callback(msg)),

  // 平台信息
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // 主题
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (_, theme) => callback(theme)),

  // 开机自启动
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),

  // 提醒
  openReminder: () => ipcRenderer.invoke('open-reminder'),
  getReminders: () => ipcRenderer.invoke('get-reminders'),
  saveReminder: (reminder) => ipcRenderer.invoke('save-reminder', reminder),
  deleteReminder: (id) => ipcRenderer.invoke('delete-reminder', id),
  onReminderTriggered: (callback) => ipcRenderer.on('reminder-triggered', (_, reminder) => callback(reminder)),

  // 应用控制
  minimizeAll: () => ipcRenderer.send('minimize-all'),
  quitApp: () => ipcRenderer.send('quit-app'),
});
