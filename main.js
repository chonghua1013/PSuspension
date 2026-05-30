const { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard, nativeImage, desktopCapturer, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const childProcess = require('child_process');



// ====== 平台检测 ======
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

let mainWindow = null;
let toolWindows = {};
let isPanelExpanded = false;
let ignoreBlurUntil = 0;
let ballCenterX = 0, ballCenterY = 0;

const BALL_SIZE = 60;
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 520;

function createWindow() {
  console.log('[窗口] 开始创建主窗口...');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  console.log('[窗口] 屏幕工作区:', sw, 'x', sh);

  // Windows: 使用透明窗口避免拖动时白色背景扩散
  // macOS: 使用非透明窗口，通过 backgroundColor 设置背景
  const winOptions = {
    width: BALL_SIZE, height: BALL_SIZE,
    x: sw - BALL_SIZE - 20, y: Math.round(sh / 2 - BALL_SIZE / 2),
    frame: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
  };

  if (isWin) {
    winOptions.transparent = true;
    winOptions.backgroundColor = '#00000000';
  } else {
    winOptions.transparent = false;
    winOptions.backgroundColor = '#f0f7ff';
  }

  mainWindow = new BrowserWindow(winOptions);
  console.log('[窗口] 窗口对象已创建, 位置:', sw - BALL_SIZE - 20, Math.round(sh / 2 - BALL_SIZE / 2));
  if (isMac) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[窗口] index.html 加载完成');
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[窗口] 加载失败:', errorCode, errorDescription, validatedURL);
    dialog.showErrorBox('页面加载失败', `错误码: ${errorCode}\n${errorDescription}\nURL: ${validatedURL}`);
  });
  mainWindow.loadFile('index.html').catch(err => {
    console.error('[窗口] loadFile 失败:', err.message);
    dialog.showErrorBox('文件加载失败', err.message);
  });
  mainWindow.on('blur', () => collapsePanel());
  console.log('[窗口] 主窗口创建完成');
}

function collapsePanel(force = false) {
  if (!mainWindow || !isPanelExpanded) return;
  if (!force && Date.now() < ignoreBlurUntil) return;
  isPanelExpanded = false;
  mainWindow.setSize(BALL_SIZE, BALL_SIZE);
  mainWindow.setPosition(Math.round(ballCenterX - BALL_SIZE/2), Math.round(ballCenterY - BALL_SIZE/2));
  mainWindow.webContents.send('panel-state', 'collapsed');
}
function markToolWindowOpening() { ignoreBlurUntil = Date.now() + 500; }

// 为工具窗口注入主题支持
function injectThemeSupport(win) {
  win.webContents.on('did-finish-load', () => {
    const themeJS = `
      (async function(){
        try {
          var t = await window.electronAPI.getTheme();
          document.documentElement.setAttribute('data-theme', t || 'light');
          window.electronAPI.onThemeChanged(function(nt){
            document.documentElement.setAttribute('data-theme', nt);
          });
        } catch(e) {}
      })();
    `;
    win.webContents.executeJavaScript(themeJS).catch(() => {});
  });
}

// ====== IPC ======
ipcMain.handle('force-collapse', () => { collapsePanel(true); });
ipcMain.handle('toggle-panel', () => {
  if (!mainWindow) return;
  if (!isPanelExpanded) {
    isPanelExpanded = true;
    const [x, y] = mainWindow.getPosition();
    ballCenterX = x + BALL_SIZE/2; ballCenterY = y + BALL_SIZE/2;
    mainWindow.setSize(PANEL_WIDTH, PANEL_HEIGHT);
    // 查找窗口当前所在的显示器（非强制主屏）
    const currentDisplay = screen.getDisplayMatching({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    const { width: sw, height: sh, x: dx, y: dy } = currentDisplay.workArea;
    let nx = x, ny = y;
    if (nx + PANEL_WIDTH > dx + sw) nx = dx + sw - PANEL_WIDTH - 10;
    if (ny + PANEL_HEIGHT > dy + sh) ny = dy + sh - PANEL_HEIGHT - 10;
    if (nx < dx) nx = dx + 10;
    mainWindow.setPosition(Math.round(nx), Math.round(ny));
    mainWindow.webContents.send('panel-state', 'expanded');
  } else collapsePanel(true); // 用户主动收起，忽略 blur 保护
});
ipcMain.on('move-window', (_, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

// ====== 工具 ======
// 截图 - 先选区域（跨平台）
ipcMain.handle('screenshot', async () => {
  ignoreBlurUntil = Date.now() + 30000;
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));
  const d = screen.getPrimaryDisplay(), { x, y, width, height } = d.bounds, sf = d.scaleFactor;
  return new Promise(resolve => {
    const w = new BrowserWindow({ width, height, x, y, frame: false, transparent: true, alwaysOnTop: true, resizable: false, hasShadow: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
    // macOS: screen-saver 级别确保在所有窗口之上；Windows: 用 floating 级别
    if (isMac) {
      w.setAlwaysOnTop(true, 'screen-saver');
    } else {
      w.setAlwaysOnTop(true, 'floating');
    }
    w.loadURL(`data:text/html,${encodeURIComponent(sc_html)}`);
    ipcMain.once('crop-done', async (_, rect) => {
      try { w.close(); } catch(e) {}
      if (!rect || rect.w < 5 || rect.h < 5) { if (mainWindow) mainWindow.show(); resolve(null); return; }
      await new Promise(r => setTimeout(r, 200));
      const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: width*sf, height: height*sf } });
      const img = src[0]?.thumbnail;
      if (!img) { if (mainWindow) mainWindow.show(); resolve(null); return; }
      const cropX = Math.round(rect.x*sf), cropY = Math.round(rect.y*sf), cropW = Math.round(rect.w*sf), cropH = Math.round(rect.h*sf);
      if (cropX < 0 || cropY < 0 || cropW <= 0 || cropH <= 0) { if (mainWindow) mainWindow.show(); resolve(null); return; }
      const cropped = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
      if (mainWindow) mainWindow.show();
      resolve(cropped.toDataURL());
    });
    ipcMain.once('crop-cancel', () => { try { w.close(); } catch(e) {} if (mainWindow) mainWindow.show(); resolve(null); });
  });
});

// 取色器 - 跨平台实现
ipcMain.handle('pick-color', async () => {
  ignoreBlurUntil = Date.now() + 5000;
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 300));

  try {
    if (isMac) {
      // macOS: 使用 AppleScript 原生取色器
      const script = `set c to choose color default color {0,0,0}
return ((item 1 of c) as string) & "," & ((item 2 of c) as string) & "," & ((item 3 of c) as string)`;
      const output = childProcess.execSync(`osascript -e '${script}'`, { encoding: 'utf8', timeout: 30000 }).trim();
      if (mainWindow) mainWindow.show();
      const parts = output.split(',');
      if (parts.length === 3) {
        const r = parseInt(parts[0]), g = parseInt(parts[1]), b = parseInt(parts[2]);
        if (!isNaN(r)) {
          const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
          return { hex, rgb: `rgb(${r},${g},${b})`, r, g, b };
        }
      }
    } else if (isWin) {
      // Windows: 使用 PowerShell 脚本调用 .NET 取色对话框
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$colorDialog = New-Object System.Windows.Forms.ColorDialog
if ($colorDialog.ShowDialog() -eq 'OK') {
  $c = $colorDialog.Color
  Write-Output "$($c.R),$($c.G),$($c.B)"
}
`;
      const tmpFile = path.join(os.tmpdir(), 'toolsfloat_colorpicker.ps1');
      fs.writeFileSync(tmpFile, psScript, 'utf-8');
      try {
        const output = childProcess.execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, { encoding: 'utf8', timeout: 60000 }).trim();
        fs.unlinkSync(tmpFile);
        if (mainWindow) mainWindow.show();
        const parts = output.split(',');
        if (parts.length === 3) {
          const r = parseInt(parts[0]), g = parseInt(parts[1]), b = parseInt(parts[2]);
          if (!isNaN(r)) {
            const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
            return { hex, rgb: `rgb(${r},${g},${b})`, r, g, b };
          }
        }
      } catch (psError) {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }
    } else {
      // Linux: 使用自定义 HTML 取色窗口（截图方式）
      const d = screen.getPrimaryDisplay();
      const { width, height } = d.bounds;
      const sf = d.scaleFactor;
      const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: width*sf, height: height*sf } });
      const img = src[0]?.thumbnail;
      if (img) {
        const dataUrl = img.toDataURL();
        if (mainWindow) mainWindow.show();
        // 返回截图数据，由前端实现取色交互
        return { type: 'screen-capture', dataUrl, width, height, sf };
      }
    }
    if (mainWindow) mainWindow.show();
    return null;
  } catch (e) {
    if (mainWindow) mainWindow.show();
    return null;
  }
});

// 记事本
ipcMain.handle('open-notepad', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.notepad) { toolWindows.notepad.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 400, height: 500, x: Math.round(sw/2-200), y: Math.round(sh/2-250), frame: true, title: '记事本',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  w.loadURL(`data:text/html,${encodeURIComponent(notepad_html)}`);
  w.on('closed', () => { toolWindows.notepad = null; });
  toolWindows.notepad = w;
  injectThemeSupport(w);
});

// 计算器
ipcMain.handle('open-calculator', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.calculator) { toolWindows.calculator.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 320, height: 460, x: Math.round(sw/2-160), y: Math.round(sh/2-230), frame: true, title: '计算器', resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  w.loadURL(`data:text/html,${encodeURIComponent(calc_html)}`);
  w.on('closed', () => { toolWindows.calculator = null; });
  toolWindows.calculator = w;
  injectThemeSupport(w);
});

// 剪贴板
let clipboardHistory = []; // 保存剪贴板历史，最多 50 条
let lastClipboardText = '';
let lastClipboardImageFingerprint = ''; // 图片指纹（dataURL 前 100 字符），用于去重

function addToClipboardHistory(item) {
  // 文本去重
  if (item.type === 'text') {
    if (!item.text || !item.text.trim()) return;
    const trimmed = item.text.trim();
    if (clipboardHistory.length > 0 && clipboardHistory[0].type === 'text' && clipboardHistory[0].text === trimmed) return;
    item.text = trimmed;
  }
  // 图片去重
  if (item.type === 'image') {
    if (!item.imageData) return;
    if (clipboardHistory.length > 0 && clipboardHistory[0].type === 'image' && clipboardHistory[0].imageData === item.imageData) return;
  }
  clipboardHistory.unshift(item);
  if (clipboardHistory.length > 50) clipboardHistory.pop();
  notifyClipboardUpdate();
}

function notifyClipboardUpdate() {
  try {
    const msg = { count: clipboardHistory.length };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clipboard-updated', msg);
    }
    if (toolWindows.clipboard && !toolWindows.clipboard.isDestroyed()) {
      toolWindows.clipboard.webContents.send('clipboard-updated', msg);
    }
  } catch (e) {}
}

function getImageFingerprint(img) {
  // 取 dataURL 前 100 字符作为简单指纹
  try {
    return img.toDataURL().substring(0, 100);
  } catch (e) { return ''; }
}

function startClipboardWatcher() {
  // 初始化基准
  try { lastClipboardText = clipboard.readText() || ''; } catch (e) { lastClipboardText = ''; }
  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) lastClipboardImageFingerprint = getImageFingerprint(img);
  } catch (e) {}

  // 每 500ms 轮询
  setInterval(() => {
    try {
      // 检查图片
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const fp = getImageFingerprint(img);
        if (fp !== lastClipboardImageFingerprint) {
          lastClipboardImageFingerprint = fp;
          addToClipboardHistory({ type: 'image', imageData: img.toDataURL(), time: Date.now() });
        }
      }
      // 检查文本（图片变化时文本可能不变，所以分开判断）
      const text = clipboard.readText();
      if (text !== lastClipboardText) {
        lastClipboardText = text;
        if (text && text.trim()) {
          addToClipboardHistory({ type: 'text', text, time: Date.now() });
        }
      }
    } catch (e) {}
  }, 500);
}

ipcMain.handle('read-clipboard', () => { try { return clipboard.readText(); } catch(e) { return ''; } });
ipcMain.handle('write-clipboard', (_, t) => { clipboard.writeText(t); lastClipboardText = t; return true; });
ipcMain.handle('write-clipboard-image', (_, dataUrl) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(img);
    lastClipboardImageFingerprint = getImageFingerprint(img);
    return true;
  } catch (e) { return false; }
});
ipcMain.handle('get-clipboard-history', () => clipboardHistory);
ipcMain.handle('clear-clipboard-history', () => { clipboardHistory = []; return true; });
ipcMain.handle('delete-clipboard-item', (_, index) => {
  if (index >= 0 && index < clipboardHistory.length) clipboardHistory.splice(index, 1);
  return true;
});
ipcMain.on('copy-text', (_, t) => { clipboard.writeText(t); lastClipboardText = t; });

// 剪贴板窗口
ipcMain.handle('open-clipboard', () => {
  markToolWindowOpening();
  // 先收起悬浮球面板
  collapsePanel(true);
  if (toolWindows.clipboard) { toolWindows.clipboard.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 440, height: 500, x: Math.round(sw/2-220), y: Math.round(sh/2-250), frame: true, title: '剪贴板历史',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  w.loadURL(`data:text/html,${encodeURIComponent(clipboard_html)}`);
  w.on('closed', () => { toolWindows.clipboard = null; });
  toolWindows.clipboard = w;
  injectThemeSupport(w);
});

// 翻译 - 百度翻译 API
const crypto = require('crypto');
ipcMain.handle('translate-text', async (_, q, from, to) => {
  const appid = '';
  const key = '';
  const salt = Date.now().toString();
  const sign = crypto.createHash('md5').update(appid + q + salt + key).digest('hex');
  const url = `https://fanyi-api.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(q)}&from=${from}&to=${to}&appid=${appid}&salt=${salt}&sign=${sign}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json.trans_result) return json.trans_result.map(r => r.dst).join('\n');
    return '翻译失败: ' + (json.error_msg || '未知错误');
  } catch (e) { return '请求失败: ' + e.message; }
});

// 文件筛选
ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('filter-files', async (_, dir, startDate, endDate) => {
  const results = [];
  const sourceDir = path.resolve(dir);
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(d, e.name);
      if (isWin) {
        try {
          if (e.name.startsWith('$') || e.name === 'System Volume Information') continue;
        } catch (_) {}
      }
      if (e.isDirectory()) { try { walk(fp); } catch (_) {} }
      else if (e.isFile()) {
        const stat = fs.statSync(fp);
        const mtime = stat.mtimeMs;
        if (mtime >= startDate && mtime <= endDate) {
          const relativePath = path.relative(sourceDir, fp);
          results.push({ path: fp, name: e.name, relativePath, size: stat.size, mtime: stat.mtime.toISOString() });
        }
      }
    }
  };
  try { walk(sourceDir); } catch (e) { return { error: e.message }; }
  return { files: results, count: results.length };
});

ipcMain.handle('copy-files', async (_, fileList, dest) => {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const file of fileList) {
    let targetDir = dest;
    let fileName = file.name || path.basename(file.path || file);
    // 保持源目录的子目录结构
    if (file.relativePath) {
      const subDir = path.dirname(file.relativePath);
      if (subDir && subDir !== '.') {
        targetDir = path.join(dest, subDir);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      }
    }
    const srcPath = file.path || file;
    let target = path.join(targetDir, fileName);
    let n = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(fileName), base = path.basename(fileName, ext);
      target = path.join(targetDir, base + '_' + n + ext); n++;
    }
    fs.copyFileSync(srcPath, target);
    copied++;
  }
  return { copied };
});

// 文件筛选窗口
ipcMain.handle('open-file-filter', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.fileFilter) { toolWindows.fileFilter.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 500, height: 440, x: Math.round(sw/2-250), y: Math.round(sh/2-240), frame: true, title: '文件筛选',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const tmpFile = path.join(os.tmpdir(), 'toolsfloat_filefilter.html');
  fs.writeFileSync(tmpFile, file_html, 'utf-8');
  w.loadFile(tmpFile);
  w.on('closed', () => { toolWindows.fileFilter = null; try { fs.unlinkSync(tmpFile); } catch(e) {} });
  toolWindows.fileFilter = w;
  injectThemeSupport(w);
});

// 悬浮表格
ipcMain.handle('open-spreadsheet', () => {
  if (toolWindows.spreadsheet) { toolWindows.spreadsheet.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 800, height: 500, x: Math.round(sw/2-400), y: Math.round(sh/2-250),
    frame: true, title: '悬浮表格', alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const tmpFile = path.join(os.tmpdir(), 'toolsfloat_sheet.html');
  fs.writeFileSync(tmpFile, sheet_html, 'utf-8');
  w.loadFile(tmpFile);
  w.on('closed', () => { toolWindows.spreadsheet = null; try { fs.unlinkSync(tmpFile); } catch(e) {} });
  toolWindows.spreadsheet = w;
  injectThemeSupport(w);
});

// 翻译窗口
ipcMain.handle('open-translator', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.translator) { toolWindows.translator.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 420, height: 480, x: Math.round(sw/2-210), y: Math.round(sh/2-240), frame: true, title: '翻译',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  w.loadURL(`data:text/html,${encodeURIComponent(trans_html)}`);
  w.on('closed', () => { toolWindows.translator = null; });
  toolWindows.translator = w;
  injectThemeSupport(w);
});

// 时间戳转换窗口
ipcMain.handle('open-timestamp', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.timestamp) { toolWindows.timestamp.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 480, height: 420, x: Math.round(sw/2-240), y: Math.round(sh/2-210), frame: true, title: '时间戳转换', resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  w.loadURL(`data:text/html,${encodeURIComponent(timestamp_html)}`);
  w.on('closed', () => { toolWindows.timestamp = null; });
  toolWindows.timestamp = w;
  injectThemeSupport(w);
});

// JSON 查看器窗口
ipcMain.handle('open-json-viewer', () => {
  markToolWindowOpening();
  collapsePanel(true);
  if (toolWindows.jsonViewer) { toolWindows.jsonViewer.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({ width: 500, height: 560, x: Math.round(sw/2-250), y: Math.round(sh/2-280), frame: true, title: 'JSON 查看器',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const tmpFile = path.join(os.tmpdir(), 'toolsfloat_jsonviewer.html');
  fs.writeFileSync(tmpFile, json_html, 'utf-8');
  w.loadFile(tmpFile);
  w.on('closed', () => { toolWindows.jsonViewer = null; try { fs.unlinkSync(tmpFile); } catch(e) {} });
  toolWindows.jsonViewer = w;
  injectThemeSupport(w);
});

// 系统信息
ipcMain.handle('system-info', () => {
  const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return {
    platform: platformNames[process.platform] || process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    totalMem: (os.totalmem()/1073741824).toFixed(1)+' GB',
    freeMem: (os.freemem()/1073741824).toFixed(1)+' GB',
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cpuCores: os.cpus().length,
    uptime: Math.floor(os.uptime()/3600)+' 小时',
  };
});

ipcMain.handle('get-platform', () => ({ platform: process.platform, isMac, isWin, isLinux }));
ipcMain.on('minimize-all', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('quit-app', () => { Object.values(toolWindows).forEach(w => { try { w.close(); } catch(e) {} }); app.quit(); });

// ====== HTML 模板 ======
const sc_html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}html,body{background:transparent;width:100vw;height:100vh;overflow:hidden;cursor:crosshair}
#m{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.25);pointer-events:none}
#s{position:fixed;border:2px solid #89b4fa;box-shadow:0 0 0 9999px rgba(0,0,0,.25);display:none;pointer-events:none;z-index:10}
#z{position:fixed;display:none;pointer-events:none;z-index:11;background:#1e1e2e;color:#cdd6f4;padding:4px 8px;border-radius:6px;font:11px monospace}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>
<div id="m"></div><div id="s"></div><div id="z"></div><script>
let sx=0,sy=0,d=0;
document.addEventListener('mousedown',e=>{sx=e.clientX;sy=e.clientY;d=1;document.getElementById('s').style.display='block';document.getElementById('z').style.display='block'});
document.addEventListener('mousemove',e=>{if(!d)return;const x=Math.min(sx,e.clientX),y=Math.min(sy,e.clientY),w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy);
document.getElementById('s').style.cssText='left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;display:block;border:2px solid #89b4fa;box-shadow:0 0 0 9999px rgba(0,0,0,.25);pointer-events:none;z-index:10';
document.getElementById('z').textContent=Math.round(w)+' x '+Math.round(h);document.getElementById('z').style.left=(e.clientX+10)+'px';document.getElementById('z').style.top=(e.clientY+10)+'px'});
document.addEventListener('mouseup',()=>{if(!d)return;d=0;const s=document.getElementById('s');
const r={x:parseFloat(s.style.left),y:parseFloat(s.style.top),w:parseFloat(s.style.width),h:parseFloat(s.style.height)};
r.w<5||r.h<5?window.electronAPI.sendCropCancel():window.electronAPI.sendCropDone(r)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.electronAPI.sendCropCancel()});
</script></body></html>`;

const notepad_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh}
.tb{display:flex;gap:8px;padding:10px 14px;background:#181825;border-bottom:1px solid #313244}
.tb button{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px}
.bs{background:#a6e3a1;color:#1e1e2e}.bc{background:#f38ba8;color:#1e1e2e}
.tb button:hover{opacity:.8}
textarea{flex:1;background:#1e1e2e;color:#cdd6f4;border:none;padding:14px;font-size:14px;resize:none;outline:none;line-height:1.6}
.st{padding:6px 14px;background:#181825;color:#6c7086;font-size:11px;text-align:right}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="tb"><button class="bs" onclick="s()">保存</button><button class="bc" onclick="c()">清空</button></div>
<textarea id="e" placeholder="写点什么..."></textarea><div class="st" id="st">字数: 0</div>
<script>
const K='float_notepad',e=document.getElementById('e'),st=document.getElementById('st');
e.value=localStorage.getItem(K)||'';u();
e.addEventListener('input',()=>{localStorage.setItem(K,e.value);u()});
function u(){st.textContent='字数: '+e.value.length}
function s(){localStorage.setItem(K,e.value);st.textContent='已保存';setTimeout(u,1500)}
function c(){if(confirm('确定清空？')){e.value='';localStorage.removeItem(K);u()}}
document.addEventListener('keydown',ev=>{if((ev.ctrlKey||ev.metaKey)&&ev.key==='s'){ev.preventDefault();s()}});
</script></body></html>`;

const calc_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh;user-select:none}
.d{background:#181825;padding:24px 20px;text-align:right;border-bottom:1px solid #313244}
.d .ex{font-size:16px;color:#6c7086;min-height:22px}
.d .re{font-size:36px;font-weight:300;color:#cdd6f4;margin-top:4px}
.bs{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:2px;background:#313244}
.bs button{border:none;font-size:20px;cursor:pointer;font-family:inherit}
.bn{background:#45475a;color:#cdd6f4}.bn:hover{background:#585b70}
.bo{background:#89b4fa;color:#1e1e2e}.bo:hover{background:#74c7ec}
.bf{background:#313244;color:#cdd6f4;font-size:16px}.bf:hover{background:#45475a}
.be{background:#a6e3a1;color:#1e1e2e}.be:hover{background:#94e2d5}
.b0{grid-column:span 2}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="d"><div class="ex" id="ex"></div><div class="re" id="re">0</div></div>
<div class="bs">
<button class="bf" onclick="cl()">C</button><button class="bf" onclick="bs()">⌫</button><button class="bf" onclick="ap('%')">%</button><button class="bo" onclick="ap('/')">÷</button>
<button class="bn" onclick="ap('7')">7</button><button class="bn" onclick="ap('8')">8</button><button class="bn" onclick="ap('9')">9</button><button class="bo" onclick="ap('*')">×</button>
<button class="bn" onclick="ap('4')">4</button><button class="bn" onclick="ap('5')">5</button><button class="bn" onclick="ap('6')">6</button><button class="bo" onclick="ap('-')">−</button>
<button class="bn" onclick="ap('1')">1</button><button class="bn" onclick="ap('2')">2</button><button class="bn" onclick="ap('3')">3</button><button class="bo" onclick="ap('+')">+</button>
<button class="bn b0" onclick="ap('0')">0</button><button class="bn" onclick="ap('.')">.</button><button class="be" onclick="ca()">=</button>
</div>
<script>
let cv='';const ex=document.getElementById('ex'),re=document.getElementById('re');
function ap(v){cv+=v;ex.textContent=cv}
function cl(){cv='';ex.textContent='';re.textContent='0'}
function bs(){cv=cv.slice(0,-1);ex.textContent=cv||''}
function ca(){
  try{let e=cv.replace(/×/g,'*').replace(/÷/g,'/').replace(/−/g,'-');
  let r=Function('"use strict";return ('+e+')')();r=Number(r.toFixed(8));re.textContent=r;cv=String(r);ex.textContent=cv}
  catch(e){re.textContent='错误'}
}
document.addEventListener('keydown',e=>{
  if(/[0-9.]/.test(e.key))ap(e.key);else if(e.key==='+')ap('+');else if(e.key==='-')ap('-');
  else if(e.key==='*')ap('*');else if(e.key==='/'){e.preventDefault();ap('/')}
  else if(e.key==='Enter'||e.key==='='){e.preventDefault();ca()}
  else if(e.key==='Backspace')bs();else if(e.key==='Escape')cl();
});
</script></body></html>`;

const file_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh}
.row{display:flex;align-items:center;gap:8px;padding:10px 14px}
.row label{font-size:13px;color:#6c7086;min-width:50px}
.row input,.row .path{flex:1;padding:7px 10px;border-radius:6px;border:1px solid #313244;background:#181825;color:#cdd6f4;font-size:13px;outline:none}
.row input:focus{border-color:#89b4fa}
.row button{padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;background:#89b4fa;color:#1e1e2e;white-space:nowrap}
.row button:hover{opacity:.85}
.btns{display:flex;gap:8px;padding:8px 14px}
.btns button{flex:1;padding:10px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500}
.btn-go{background:#a6e3a1;color:#1e1e2e}
.btn-cc{background:#f38ba8;color:#1e1e2e}
.btns button:hover{opacity:.85}
#log{flex:1;overflow-y:auto;padding:10px 14px;font:12px monospace;color:#6c7086;line-height:1.6}
#log .err{color:#f38ba8}
#log .ok{color:#a6e3a1}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="row"><label>源文件夹</label><span class="path" id="src"></span><button onclick="pickSrc()">选择</button></div>
<div class="row"><label>开始日期</label><input type="date" id="d1"></div>
<div class="row"><label>结束日期</label><input type="date" id="d2"></div>
<div class="row"><label>目标目录</label><span class="path" id="dst"></span><button onclick="pickDst()">选择</button></div>
<div class="btns"><button class="btn-go" onclick="go()">开始筛选并复制</button><button class="btn-cc" onclick="clr()">清空</button></div>
<div id="log"></div>
<script>
const CACHE_KEY='filefilter_cache';
let src='',dst='',files=[];

function pad(n){return String(n).padStart(2,'0')}
function dateStr(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function saveCache(){localStorage.setItem(CACHE_KEY,JSON.stringify({src,dst}))}
function loadCache(){
  try{
    var c=JSON.parse(localStorage.getItem(CACHE_KEY));
    if(c&&c.src){src=c.src;document.getElementById('src').textContent=src}
    if(c&&c.dst){dst=c.dst;document.getElementById('dst').textContent=dst}
  }catch(e){}
}
// 默认日期：今天 → 明天
var today=new Date();
var tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
document.getElementById('d1').value=dateStr(today);
document.getElementById('d2').value=dateStr(tomorrow);
loadCache();

async function pickSrc(){
  src=await window.electronAPI.selectFolder();
  if(src){document.getElementById('src').textContent=src;saveCache()}
}
async function pickDst(){
  dst=await window.electronAPI.selectFolder();
  if(dst){document.getElementById('dst').textContent=dst;saveCache()}
}
function log(m,c){const l=document.getElementById('log');l.innerHTML+='<div class="'+c+'">'+m+'</div>';l.scrollTop=l.scrollHeight}
function clr(){document.getElementById('log').innerHTML='';files=[]}
async function go(){
  const d1=+new Date(document.getElementById('d1').value);
  const d2=+new Date(document.getElementById('d2').value+ 'T23:59:59');
  if(!src||!dst||!d1||!d2)return log('请填写完整信息','err');
  if(d1>d2)return log('开始日期不能晚于结束日期','err');
  log('开始扫描 '+src+' ...','');
  await new Promise(r=>setTimeout(r,20));
  const r=await window.electronAPI.filterFiles(src,d1,d2);
  if(r.error){log('扫描失败: '+r.error,'err');return}
  log('找到 '+r.count+' 个文件','ok');
  if(r.count===0)return;
  log('复制到 '+dst+' ...','');
  await new Promise(r=>setTimeout(r,20));
  const c=await window.electronAPI.copyFiles(r.files,dst);
  log('完成! 已复制 '+c.copied+' 个文件','ok');
}
</script></body></html>`;

const sheet_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;height:100vh;display:flex;flex-direction:column;user-select:none}
.tb{display:flex;gap:6px;padding:6px 10px;background:#181825;border-bottom:1px solid #313244;align-items:center}
.tb button{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#45475a;color:#cdd6f4}
.tb button:hover{background:#585b70}
.tb .sep{width:1px;height:20px;background:#313244;margin:0 4px}
.grid-wrap{flex:1;overflow:auto;position:relative}
.grid-wrap::-webkit-scrollbar{width:6px;height:6px}
.grid-wrap::-webkit-scrollbar-thumb{background:#45475a;border-radius:3px}
table{border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid #313244;width:80px;height:28px;padding:0;text-align:left;vertical-align:top;position:relative}
th{background:#181825;color:#6c7086;font-size:11px;font-weight:500;text-align:center;position:sticky;top:0;z-index:2}
th:first-child,td:first-child{width:40px;min-width:40px;text-align:center;color:#6c7086;font-size:11px;background:#181825;position:sticky;left:0;z-index:1}
th:first-child{z-index:3}
td.hl{outline:1px solid #89b4fa;outline-offset:-1px;background:#252536}
td.hl .fh{display:block}
td.hl:first-of-type .fh,.td-onerow-active .fh{display:block}
.active-cell{outline:2px solid #a6e3a1;outline-offset:-2px;z-index:5}
td input{width:100%;height:100%;border:none;background:transparent;color:#cdd6f4;font-size:13px;padding:3px 6px;outline:none;font-family:inherit}
.fh{display:none;position:absolute;right:-4px;bottom:-4px;width:8px;height:8px;background:#89b4fa;border:1px solid #1e1e2e;cursor:crosshair;z-index:10}
.fh:hover{transform:scale(1.5)}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="tb">
  <button onclick="addRow()">+ 行</button>
  <button onclick="addCol()">+ 列</button>
  <button onclick="delRow()">- 行</button>
  <button onclick="delCol()">- 列</button>
  <span class="sep"></span>
  <button onclick="copySel()" title="Ctrl+C">📋 复制选区</button>
  <button onclick="saveData()">💾 保存</button>
  <button onclick="clearAll()">🗑 清空</button>
  <span style="flex:1"></span>
  <span style="font-size:11px;color:#6c7086" id="info"></span>
</div>
<div class="grid-wrap" id="wrap"><table id="tbl"></table></div>
<script>
const ROWS=50,COLS=15,wrap=document.getElementById('wrap'),tbl=document.getElementById('tbl'),info=document.getElementById('info');
let activeR=-1,activeC=-1,data={},fillR1=-1,fillC1=-1,fillR2=-1,fillC2=-1;
let selR1=-1,selC1=-1,selR2=-1,selC2=-1; // 多选范围

try{data=JSON.parse(localStorage.getItem('sheet_data')||'{}')}catch(e){data={}}

function colName(c){let s='';while(c>=0){s=String.fromCharCode(65+c%26)+s;c=Math.floor(c/26)-1}return s}

function render(){
  tbl.innerHTML='';
  let h='<tr><th></th>';
  for(let c=0;c<COLS;c++)h+='<th>'+colName(c)+'</th>';
  h+='</tr>';tbl.innerHTML=h;
  for(let r=0;r<ROWS;r++){
    let tr='<tr><td>'+ (r+1) +'</td>';
    for(let c=0;c<COLS;c++)tr+='<td data-r='+r+' data-c='+c+'><span class="val">'+ (data[r+','+c]||'') +'</span><div class="fh"></div></td>';
    tr+='</tr>';tbl.innerHTML+=tr;
  }
  bindCells();
}

function highlightRange() {
  tbl.querySelectorAll('td.hl').forEach(t=>t.classList.remove('hl'));
  if(selR2<0||selC2<0) return;
  const r1=Math.min(selR1,selR2), r2=Math.max(selR1,selR2);
  const c1=Math.min(selC1,selC2), c2=Math.max(selC1,selC2);
  for(let r=r1;r<=r2;r++)
    for(let c=c1;c<=c2;c++){
      const td=tbl.querySelector('td[data-r="'+r+'"][data-c="'+c+'"]');
      if(td) td.classList.add('hl');
    }
}

function selectSingle(r,c) {
  selR1=selR2=r; selC1=selC2=c;
  activeR=r; activeC=c;
  highlightRange();
}

function selectRange(r,c) {
  selR2=r; selC2=c;
  activeR=r; activeC=c;
  highlightRange();
}

let selDragging=false, selStartR,selStartC;

function bindCells(){
  tbl.querySelectorAll('td[data-r]').forEach(td=>{
    td.addEventListener('dblclick',edit);
    td.addEventListener('mousedown',e=>{
      if(e.target.classList.contains('fh')){ e.stopPropagation();e.preventDefault();startFill(+td.dataset.r,+td.dataset.c);return; }
      selStartR=+td.dataset.r; selStartC=+td.dataset.c;
      if(e.shiftKey && activeR>=0) {
        selectRange(selStartR,selStartC);
      } else {
        selectSingle(selStartR,selStartC);
      }
      selDragging=true;
    });
    td.addEventListener('mouseenter',()=>{
      if(!selDragging) return;
      selectRange(+td.dataset.r, +td.dataset.c);
    });
  });
}
document.addEventListener('mouseup',()=>{
  if(!selDragging) return;
  selDragging=false;
  // 强制保留高亮
  highlightRange();
  const r1=Math.min(selR1,selR2),r2=Math.max(selR1,selR2);
  const c1=Math.min(selC1,selC2),c2=Math.max(selC1,selC2);
  info.textContent=colName(c1)+(r1+1)+' → '+colName(c2)+(r2+1)+' ('+(r2-r1+1)+'R×'+(c2-c1+1)+'C)';
  // 防止后续 click 事件误清除选择
  window._justSelected = Date.now();
});
// 点击空白处取消选择
document.addEventListener('click',e=>{
  if(window._justSelected && Date.now() - window._justSelected < 100) return;
  if(!e.target.closest('td[data-r]')&&!e.target.closest('.tb')&&selR1>=0){
    selR1=selR2=selC1=selC2=-1;activeR=activeC=-1;
    tbl.querySelectorAll('td.hl').forEach(t=>t.classList.remove('hl'));
    info.textContent='';
  }
});

function startFill(r,c){
  fillR1=r;fillC1=c;
  const onMove=e=>{
    const t=document.elementFromPoint(e.clientX,e.clientY);
    if(t&&t.dataset.r){fillR2=+t.dataset.r;fillC2=+t.dataset.c}
    tbl.querySelectorAll('td.fill-hl').forEach(td=>td.classList.remove('fill-hl'));
    if(fillR2>=0){
      for(let rr=Math.min(fillR1,fillR2);rr<=Math.max(fillR1,fillR2);rr++)
        for(let cc=Math.min(fillC1,fillC2);cc<=Math.max(fillC1,fillC2);cc++){
          const td=tbl.querySelector('td[data-r="'+rr+'"][data-c="'+cc+'"]');
          if(td)td.classList.add('fill-hl');
        }
    }
  };
  const onUp=()=>{
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
    tbl.querySelectorAll('td.fill-hl').forEach(td=>td.classList.remove('fill-hl'));
    if(fillR2<0||fillC2<0)return;
    doFill();render();setActive(fillR2,fillC2);
  };
  document.addEventListener('mousemove',onMove);
  document.addEventListener('mouseup',onUp);
}

function doFill(){
  const src=data[fillR1+','+fillC1]||'';
  const isNum=/^\d+$/.test(src);
  let val=isNum?parseInt(src):null;
  for(let r=Math.min(fillR1,fillR2);r<=Math.max(fillR1,fillR2);r++)
    for(let c=Math.min(fillC1,fillC2);c<=Math.max(fillC1,fillC2);c++){
      if(r===fillR1&&c===fillC1)continue;
      if(c===fillC1&&isNum)val=(parseInt(src)+r-fillR1);
      data[r+','+c]=isNum?String(val):src;
    }
}

function edit(e){
  const td=e.target.closest('td[data-r]');
  if(!td)return;
  const r=+td.dataset.r, c=+td.dataset.c;
  const inp=document.createElement('input');
  inp.value=data[r+','+c]||'';
  td.querySelector('.val').textContent='';td.appendChild(inp);inp.focus();inp.select();
  inp.addEventListener('blur',()=>{data[r+','+c]=inp.value;render();setActiveAndSelect(r,c)});
  inp.addEventListener('keydown',ev=>{
    if(ev.key==='Enter'){ev.preventDefault();data[r+','+c]=inp.value;render();setActiveAndSelect(r+1,c)}
    if(ev.key==='Tab'){ev.preventDefault();data[r+','+c]=inp.value;render();setActiveAndSelect(r,c+1)}
    if(ev.key==='Escape'){data[r+','+c]=inp.value;render();setActiveAndSelect(r,c)}
  });
}

function setActiveAndSelect(r,c){
  if(r<0||r>=ROWS||c<0||c>=COLS)return;
  selectSingle(r,c);
  info.textContent=colName(c)+(r+1);
}

function setActive(r,c){
  if(r<0||r>=ROWS||c<0||c>=COLS)return;
  selectSingle(r,c);
  info.textContent=colName(c)+(r+1);
}

function addRow(){for(let c=0;c<COLS;c++)for(let r=ROWS-1;r>=0;r--)data[(r+1)+','+c]=data[r+','+c];for(let c=0;c<COLS;c++)delete data['0,'+c];render()}
function addCol(){for(let r=0;r<ROWS;r++)for(let c=COLS-1;c>=0;c--)data[r+','+(c+1)]=data[r+','+c];for(let r=0;r<ROWS;r++)delete data[r+','+0];render()}
function delRow(){if(activeR>=0){for(let c=0;c<COLS;c++)for(let r=activeR;r<ROWS-1;r++)data[r+','+c]=data[(r+1)+','+c];for(let c=0;c<COLS;c++)delete data[(ROWS-1)+','+c];render()}}
function delCol(){if(activeC>=0){for(let r=0;r<ROWS;r++)for(let c=activeC;c<COLS-1;c++)data[r+','+c]=data[r+','+(c+1)];for(let r=0;r<ROWS;r++)delete data[r+','+(COLS-1)];render()}}
function saveData(){localStorage.setItem('sheet_data',JSON.stringify(data));info.textContent='已保存'}
function clearAll(){if(confirm('确定清空所有数据？')){data={};localStorage.removeItem('sheet_data');render()}}

// Ctrl+S 保存
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();saveData()}});

// Ctrl+V 粘贴多列数据（支持从 Excel 直接粘贴）
document.addEventListener('paste',e=>{
  const ct=activeR>=0&&activeC>=0;
  if(!ct)return;
  e.preventDefault();
  const text=e.clipboardData.getData('text/plain');
  if(!text)return;
  const rows=text.split(/\\r?\\n/).filter(r=>r.trim()!=='');
  if(!rows.length)return;
  for(let ri=0;ri<rows.length;ri++){
    const cols=rows[ri].split('\\t');
    for(let ci=0;ci<cols.length;ci++){
      const rr=activeR+ri, cc=activeC+ci;
      if(rr<ROWS&&cc<COLS)data[rr+','+cc]=cols[ci].trim();
    }
  }
  render();
  setActive(activeR, activeC);
  info.textContent='已粘贴 '+rows.length+' 行 x '+rows[0].split('\\t').length+' 列';
});

// 复制：Ctrl+C 复制选中单元格（支持多选）
document.addEventListener('copy',e=>{
  if(document.activeElement.tagName==='INPUT')return;
  if(selR2<0||selC2<0)return;
  const r1=Math.min(selR1,selR2), r2=Math.max(selR1,selR2);
  const c1=Math.min(selC1,selC2), c2=Math.max(selC1,selC2);
  const lines=[];
  for(let r=r1;r<=r2;r++){
    const row=[];
    for(let c=c1;c<=c2;c++) row.push(data[r+','+c]||'');
    lines.push(row.join('\\t'));
  }
  e.clipboardData.setData('text/plain',lines.join('\\n'));
  e.preventDefault();
  info.textContent='已复制 '+(r2-r1+1)+' 行 x '+(c2-c1+1)+' 列';
});

// Ctrl+A 全选
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='a'){e.preventDefault();selR1=selC1=0;selR2=ROWS-1;selC2=COLS-1;activeR=0;activeC=0;highlightRange();info.textContent='全选 50R×15C'}
});

function copySel(){
  if(selR2<0)return;
  const r1=Math.min(selR1,selR2),r2=Math.max(selR1,selR2);
  const c1=Math.min(selC1,selC2),c2=Math.max(selC1,selC2);
  const lines=[];
  for(let r=r1;r<=r2;r++){
    const row=[];for(let c=c1;c<=c2;c++)row.push(data[r+','+c]||'');lines.push(row.join('\t'));
  }
  navigator.clipboard.writeText(lines.join('\\n')).then(()=>info.textContent='已复制');
}

document.head.insertAdjacentHTML('beforeend','<style>td.fill-hl{outline:1px dashed #89b4fa;outline-offset:-1px;background:#252540}</style>');
render();
</script></body></html>`;

const trans_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh}
.hd{background:#181825;padding:12px 14px;border-bottom:1px solid #313244;display:flex;gap:8px;align-items:center}
.hd select{padding:4px 8px;border-radius:6px;border:1px solid #313244;background:#313244;color:#cdd6f4;font-size:13px;outline:none}
.hd span{color:#6c7086;font-size:13px}
textarea{flex:1;background:#1e1e2e;color:#cdd6f4;border:none;padding:14px;font-size:14px;resize:none;outline:none;line-height:1.6}
textarea#out{background:#181825;color:#a6e3a1}
.act{display:flex;gap:8px;padding:0 14px 10px}
.act button{padding:8px 20px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;flex:1}
.btn-t{background:#89b4fa;color:#1e1e2e}
.btn-c{background:#f38ba8;color:#1e1e2e}
.btn-s{background:#a6e3a1;color:#1e1e2e}
.act button:hover{opacity:.85}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="hd">
  <select id="from"><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option><option value="kor">韩语</option><option value="fr">法语</option><option value="de">德语</option><option value="ru">俄语</option></select>
  <span>→</span>
  <select id="to"><option value="zh">中文</option><option value="en" selected>英语</option><option value="ja">日语</option><option value="kor">韩语</option><option value="fr">法语</option><option value="de">德语</option><option value="ru">俄语</option></select>
</div>
<textarea id="in" placeholder="输入要翻译的文字..."></textarea>
<div class="act">
  <button class="btn-t" onclick="tran()">翻译</button>
  <button class="btn-s" onclick="swp()">交换语言</button>
  <button class="btn-c" onclick="clr()">清空</button>
</div>
<textarea id="out" placeholder="翻译结果..." readonly></textarea>
<script>
const inp=document.getElementById('in'),out=document.getElementById('out');
const fm=document.getElementById('from'),to=document.getElementById('to');
async function tran(){
  const q=inp.value.trim();if(!q)return;
  out.value='翻译中...';
  try{
    const r=await window.electronAPI.translate(q,fm.value,to.value);
    out.value=r;
  }catch(e){out.value='翻译失败: '+e}
}
function swp(){const f=fm.value,t=to.value;fm.value=t;to.value=f;const t2=inp.value;inp.value=out.value;out.value=t2}
function clr(){inp.value='';out.value=''}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();tran()}});
</script></body></html>`;

const timestamp_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;padding:20px;display:flex;flex-direction:column;height:100vh;gap:16px}
h2{font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px}
h2 span{font-size:20px}
.card{background:#181825;border-radius:12px;padding:16px;border:1px solid #313244}
.card-title{font-size:13px;color:#6c7086;margin-bottom:12px;font-weight:500}
.row{display:flex;gap:8px;align-items:center}
.row input, .row select{flex:1;padding:9px 12px;border-radius:8px;border:1px solid #313244;background:#1e1e2e;color:#cdd6f4;font-size:14px;outline:none;font-family:monospace}
.row input:focus, .row select:focus{border-color:#89b4fa;box-shadow:0 0 0 3px rgba(137,180,250,0.15)}
.row button{padding:9px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap}
.btn-go{background:#89b4fa;color:#1e1e2e}.btn-go:hover{opacity:.85}
.btn-now{background:#a6e3a1;color:#1e1e2e}.btn-now:hover{opacity:.85}
.btn-copy{background:#cba6f7;color:#1e1e2e}.btn-copy:hover{opacity:.85}
.result{margin-top:10px;padding:12px;background:#1e1e2e;border-radius:8px;min-height:44px;display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.result .val{font-family:monospace;font-size:15px;color:#a6e3a1;word-break:break-all;flex:1}
.result .val.empty{color:#6c7086}
.result .copy-btn{flex-shrink:0;padding:4px 10px;border:none;border-radius:6px;cursor:pointer;font-size:11px;background:#45475a;color:#cdd6f4}
.result .copy-btn:hover{background:#cba6f7;color:#1e1e2e}
.now-info{font-size:12px;color:#6c7086;margin-top:4px}
.hint{font-size:11px;color:#6c7086;margin-top:6px}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<h2><span>🕐</span> 时间戳转换</h2>

<!-- 时间戳 → 日期 -->
<div class="card">
  <div class="card-title">📅 时间戳 → 日期时间</div>
  <div class="row">
    <input type="text" id="tsIn" placeholder="输入时间戳（秒或毫秒）" autofocus>
    <button class="btn-go" onclick="tsToDate()">转换</button>
    <button class="btn-now" onclick="setNowTs()">当前</button>
  </div>
  <div class="hint">支持 10 位（秒）或 13 位（毫秒）时间戳，自动识别</div>
  <div class="result" id="tsResult">
    <span class="val empty">等待输入...</span>
  </div>
</div>

<!-- 日期 → 时间戳 -->
<div class="card">
  <div class="card-title">⏰ 日期时间 → 时间戳</div>
  <div class="row">
    <input type="text" id="dtIn" placeholder="YYYY-MM-DD HH:mm:ss">
    <button class="btn-go" onclick="dateToTs()">转换</button>
    <button class="btn-now" onclick="setNowDt()">当前</button>
  </div>
  <div class="hint">支持格式: 2024-01-15 14:30:00 或 2024/01/15 14:30:00</div>
  <div class="result" id="dtResult">
    <span class="val empty">等待输入...</span>
  </div>
</div>

<script>
const tsIn=document.getElementById('tsIn'),tsResult=document.getElementById('tsResult');
const dtIn=document.getElementById('dtIn'),dtResult=document.getElementById('dtResult');

function pad(n){return String(n).padStart(2,'0')}

function formatDate(d){
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+
    pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+' .'+String(d.getMilliseconds()).padStart(3,'0');
}

function makeResultEl(tsSec,tsMs,dateStr){
  const html='<span class="val">'+dateStr+'</span>'+
    '<span style="color:#6c7086;font-size:12px;font-family:monospace">秒: '+tsSec+' | 毫秒: '+tsMs+'</span>'+
    '<button class="copy-btn" onclick="copyText(\''+tsSec+'\')">复制秒</button>'+
    '<button class="copy-btn" onclick="copyText(\''+tsMs+'\')">复制毫秒</button>'+
    '<button class="copy-btn" onclick="copyText(\''+dateStr+'\')">复制日期</button>';
  return html;
}

function tsToDate(){
  const v=tsIn.value.trim();
  if(!v){tsResult.innerHTML='<span class="val empty">请输入时间戳</span>';return}
  let ts=parseInt(v);
  if(isNaN(ts)){tsResult.innerHTML='<span class="val" style="color:#f38ba8">无效的时间戳</span>';return}
  // 13位→毫秒, 10位→秒
  if(String(ts).length>=13){}else{ts*=1000}
  const d=new Date(ts);
  if(isNaN(d.getTime())){tsResult.innerHTML='<span class="val" style="color:#f38ba8">无效的时间戳</span>';return}
  const sec=Math.floor(ts/1000), ms=ts;
  tsResult.innerHTML=makeResultEl(sec,ms,formatDate(d));
}

function dateToTs(){
  const v=dtIn.value.trim();
  if(!v){dtResult.innerHTML='<span class="val empty">请输入日期时间</span>';return}
  // 支持 - 或 / 分隔符
  const d=new Date(v.replace(/\//g,'-'));
  if(isNaN(d.getTime())){dtResult.innerHTML='<span class="val" style="color:#f38ba8">无效的日期格式</span>';return}
  const ms=d.getTime(), sec=Math.floor(ms/1000);
  dtResult.innerHTML=makeResultEl(sec,ms,formatDate(d));
}

function setNowTs(){
  const ms=Date.now(), sec=Math.floor(ms/1000);
  tsIn.value=sec;
  tsToDate();
}

function setNowDt(){
  dtIn.value=formatDate(new Date()).split('.')[0];
  dateToTs();
}

function copyText(text){
  navigator.clipboard.writeText(text).then(()=>{
    const btns=document.querySelectorAll('.copy-btn');
    btns.forEach(b=>{if(b.textContent.includes('已复制'))b.textContent=b.textContent.replace('已复制','复制')});
    event.target.textContent='✓ 已复制';
    setTimeout(()=>{event.target.textContent='复制'+event.target.textContent.replace('✓ ','')},1500);
  }).catch(()=>{});
}

// 回车触发转换
tsIn.addEventListener('keydown',e=>{if(e.key==='Enter')tsToDate()});
dtIn.addEventListener('keydown',e=>{if(e.key==='Enter')dateToTs()});

// 初始化：自动填入当前时间戳
setNowTs();
</script></body></html>`;

const json_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,monospace,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh}
.hd{background:#181825;padding:12px 14px;border-bottom:1px solid #313244;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
.hd h2{font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}
.hd button{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500}
.btn-format{background:#89b4fa;color:#1e1e2e}.btn-format:hover{opacity:.85}
.btn-copy{background:#a6e3a1;color:#1e1e2e}.btn-copy:hover{opacity:.85}
.btn-clear{background:#f38ba8;color:#1e1e2e}.btn-clear:hover{opacity:.85}
.editor-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
textarea{flex:1;background:#181825;color:#cdd6f4;border:none;padding:14px;font-size:13px;resize:none;outline:none;line-height:1.5;font-family:monospace}
textarea::placeholder{color:#6c7086}
.tree-wrap{flex:1;overflow:auto;padding:12px 12px 12px 4px;display:none}
.tree-wrap.show{display:block;flex:1}
.tree-wrap::-webkit-scrollbar{width:4px}
.tree-wrap::-webkit-scrollbar-thumb{background:#45475a;border-radius:2px}
.tree-row{display:flex;align-items:flex-start;line-height:1.7;font-size:13px;white-space:nowrap}
.tree-row .toggle{width:14px;text-align:center;cursor:pointer;color:#6c7086;user-select:none;font-size:11px;flex-shrink:0;line-height:1.7}
.tree-row .toggle:hover{color:#cdd6f4}
.tree-children{padding-left:18px}
.tree-children.collapsed{display:none}
.tree-key-name{color:#89b4fa}
.tree-str{color:#a6e3a1}
.tree-num{color:#fab387}
.tree-bool{color:#cba6f7}
.tree-null{color:#6c7086;font-style:italic}
.tree-bracket{color:#6c7086}
.tree-comma{color:#6c7086}
.tree-info{color:#6c7086;font-size:11px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#a6e3a1;color:#1e1e2e;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100}
.toast.show{opacity:1}
.error{color:#f38ba8;padding:20px;font-size:13px}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="hd">
  <h2><span>{ }</span> JSON 查看器</h2>
  <div style="display:flex;gap:6px">
    <button class="btn-format" id="btnFormat">格式化</button>
    <button class="btn-copy" id="btnCopy">复制 JSON</button>
    <button class="btn-clear" id="btnClear">清空</button>
    <button class="btn-paste" id="btnPaste" style="background:#fab387;color:#1e1e2e">📋 从剪贴板读取</button>
  </div>
</div>
<div class="editor-wrap">
  <textarea id="inp" placeholder="粘贴压缩的 JSON..."></textarea>
  <div class="tree-wrap" id="tree"></div>
</div>
<div class="toast" id="toast"></div>
<script>
const inp=document.getElementById('inp'),tree=document.getElementById('tree'),toast=document.getElementById('toast');
let currentJson=null;

function showToast(msg){
  toast.textContent=msg;toast.classList.add('show');
  setTimeout(function(){toast.classList.remove('show')},1500);
}

function esc(s){var d=document.createTextNode(s);return d.textContent||''}

function buildTree(key,val){
  var row=document.createElement('div');
  row.className='tree-row';

  // key 名
  var keySpan=document.createElement('span');
  keySpan.className='tree-key-name';
  keySpan.textContent='"'+esc(key)+'"';
  row.appendChild(keySpan);

  // 冒号
  row.appendChild(document.createTextNode(': '));

  if(val===null){
    var s=document.createElement('span');
    s.className='tree-null';s.textContent='null';
    row.appendChild(s);
    return {row:row, children:null};
  }
  if(typeof val==='boolean'){
    var s=document.createElement('span');
    s.className='tree-bool';s.textContent=String(val);
    row.appendChild(s);
    return {row:row, children:null};
  }
  if(typeof val==='number'){
    var s=document.createElement('span');
    s.className='tree-num';s.textContent=String(val);
    row.appendChild(s);
    return {row:row, children:null};
  }
  if(typeof val==='string'){
    var s=document.createElement('span');
    s.className='tree-str';s.textContent='"'+esc(val)+'"';
    row.appendChild(s);
    return {row:row, children:null};
  }
  if(Array.isArray(val)){
    var toggle=document.createElement('span');
    toggle.className='toggle';toggle.textContent='▼';
    row.appendChild(toggle);
    row.appendChild(document.createTextNode(' '));
    var info=document.createElement('span');
    info.className='tree-bracket';info.textContent='[';
    row.appendChild(info);
    info=document.createElement('span');
    info.className='tree-info';info.textContent=' '+val.length+'项';
    row.appendChild(info);
    var children=document.createElement('div');
    children.className='tree-children';
    val.forEach(function(item,i){
      var r=buildTree(String(i),item);
      children.appendChild(r.row);
      if(i<val.length-1){
        var comma=document.createElement('span');
        comma.className='tree-comma';comma.textContent=',';
        children.appendChild(comma);
      }
    });
    // 闭合
    var close=document.createElement('div');
    close.className='tree-row';
    var cb=document.createElement('span');
    cb.className='tree-bracket';cb.textContent=']';
    close.appendChild(cb);
    children.appendChild(close);
    // 切换事件
    toggle.addEventListener('click',function(){
      if(children.classList.contains('collapsed')){
        children.classList.remove('collapsed');
        toggle.textContent='▼';
      }else{
        children.classList.add('collapsed');
        toggle.textContent='▶';
      }
    });
    return {row:row, children:children};
  }
  if(typeof val==='object'){
    var toggle=document.createElement('span');
    toggle.className='toggle';toggle.textContent='▼';
    row.appendChild(toggle);
    row.appendChild(document.createTextNode(' '));
    var info=document.createElement('span');
    info.className='tree-bracket';info.textContent='{';
    row.appendChild(info);
    var keys=Object.keys(val);
    info=document.createElement('span');
    info.className='tree-info';info.textContent=' '+keys.length+'键';
    row.appendChild(info);
    var children=document.createElement('div');
    children.className='tree-children';
    keys.forEach(function(k,i){
      var r=buildTree(k,val[k]);
      children.appendChild(r.row);
      if(i<keys.length-1){
        var comma=document.createElement('span');
        comma.className='tree-comma';comma.textContent=',';
        children.appendChild(comma);
      }
    });
    var close=document.createElement('div');
    close.className='tree-row';
    var cb=document.createElement('span');
    cb.className='tree-bracket';cb.textContent='}';
    close.appendChild(cb);
    children.appendChild(close);
    toggle.addEventListener('click',function(){
      if(children.classList.contains('collapsed')){
        children.classList.remove('collapsed');
        toggle.textContent='▼';
      }else{
        children.classList.add('collapsed');
        toggle.textContent='▶';
      }
    });
    return {row:row, children:children};
  }
  row.appendChild(document.createTextNode(String(val)));
  return {row:row, children:null};
}

function appendResult(wrap, r){
  wrap.appendChild(r.row);
  if(r.children){wrap.appendChild(r.children)}
}

function doFormat(){
  var text=inp.value.trim();
  if(!text){tree.innerHTML='<div class="error">请输入 JSON 数据</div>';tree.classList.add('show');inp.style.display='none';return}
  try{
    tree.innerHTML='';
    currentJson=JSON.parse(text);
    var wrap=document.createElement('div');
    if(Array.isArray(currentJson)){
      currentJson.forEach(function(item,i){
        var r=buildTree(String(i),item);
        appendResult(wrap, r);
        if(i<currentJson.length-1){
          var comma=document.createElement('span');
          comma.className='tree-comma';comma.textContent=',';
          wrap.appendChild(comma);
        }
      });
    }else{
      var keys=Object.keys(currentJson);
      keys.forEach(function(k,i){
        var r=buildTree(k,currentJson[k]);
        appendResult(wrap, r);
        if(i<keys.length-1){
          var comma=document.createElement('span');
          comma.className='tree-comma';comma.textContent=',';
          wrap.appendChild(comma);
        }
      });
    }
    tree.appendChild(wrap);
    tree.classList.add('show');
    inp.style.display='none';
  }catch(e){
    tree.innerHTML='<div class="error">JSON 解析失败: '+esc(e.message)+'</div>';
    tree.classList.add('show');
    inp.style.display='none';
  }
}

document.getElementById('btnFormat').addEventListener('click',doFormat);
document.getElementById('btnClear').addEventListener('click',function(){
  inp.value='';inp.style.display='';tree.innerHTML='';tree.classList.remove('show');currentJson=null;
});
document.getElementById('btnCopy').addEventListener('click',function(){
  if(!currentJson){showToast('请先格式化 JSON');return}
  navigator.clipboard.writeText(JSON.stringify(currentJson)).then(function(){showToast('✅ 已复制')});
});
document.getElementById('btnPaste').addEventListener('click',async function(){
  var text=await window.electronAPI.readClipboard();
  if(text){inp.value=text;doFormat()}else{showToast('剪贴板为空')}
});
inp.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();doFormat()}
});
</script></body></html>`;

const clipboard_html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4;display:flex;flex-direction:column;height:100vh}
.hd{background:#181825;padding:12px 14px;border-bottom:1px solid #313244;display:flex;justify-content:space-between;align-items:center}
.hd h2{font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}
.hd span{font-size:12px;color:#6c7086}
.hd button{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;background:#f38ba8;color:#1e1e2e}
.hd button:hover{opacity:.8}
.list{flex:1;overflow-y:auto;padding:8px}
.list::-webkit-scrollbar{width:4px}
.list::-webkit-scrollbar-thumb{background:#45475a;border-radius:2px}
.item{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;transition:.15s;margin-bottom:2px;position:relative}
.item:hover{background:#252536}
.item:hover .del{opacity:1}
.item .content{flex:1;min-width:0}
.item .text{font-size:13px;color:#cdd6f4;line-height:1.5;word-break:break-all;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.item .thumb{width:60px;height:60px;border-radius:6px;object-fit:cover;background:#313244;flex-shrink:0;cursor:zoom-in}
.item .thumb:hover{outline:2px solid #89b4fa}
.item .time{font-size:11px;color:#6c7086;margin-top:4px}
.item .del{width:22px;height:22px;border-radius:50%;border:none;background:transparent;color:#6c7086;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:0;transition:.15s}
.item .del:hover{background:#f38ba8;color:#1e1e2e}
.empty{text-align:center;padding:40px 20px;color:#6c7086;font-size:13px}
.empty .icon{font-size:40px;margin-bottom:10px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#a6e3a1;color:#1e1e2e;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100}
.toast.show{opacity:1}
/* 图片预览弹窗 */
.preview-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.85);z-index:200;display:none;align-items:center;justify-content:center;cursor:zoom-out}
.preview-overlay.show{display:flex}
.preview-overlay img{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
.preview-close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,255,255,.15);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
.preview-close:hover{background:rgba(255,255,255,.3)}
.preview-copy{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 20px;border:none;border-radius:8px;cursor:pointer;font-size:13px;background:#89b4fa;color:#1e1e2e;font-weight:500}
.preview-copy:hover{opacity:.85}
</style>
<style>
  /* 浅色主题覆盖 */
  [data-theme="light"] body, [data-theme="light"] { background: #f0f7ff !important; color: #1a3a5c !important; }
  [data-theme="light"] textarea { background: #e1f0ff !important; color: #1a3a5c !important; }
  [data-theme="light"] .hd,[data-theme="light"] .tb,[data-theme="light"] .d,[data-theme="light"] .st,[data-theme="light"] .panel-footer { background: #e1f0ff !important; }
  [data-theme="light"] .row input,[data-theme="light"] .row .path,[data-theme="light"] select,[data-theme="light"] .card { background: #e1f0ff !important; color: #1a3a5c !important; border-color: #d0e5ff !important; }
  [data-theme="light"] .tool-item:hover,[data-theme="light"] .clip-history-item:hover { background: #d0e5ff !important; }
  [data-theme="light"] .tool-shortcut { background: #d0e5ff !important; color: #6b8aaa !important; }
  [data-theme="light"] .empty,[data-theme="light"] .tool-category,[data-theme="light"] .tool-desc,[data-theme="light"] span { color: #6b8aaa; }
  [data-theme="light"] .tool-name,[data-theme="light"] .tool-info div:first-child { color: #1a3a5c !important; }
</style></head><body>

<div class="hd">
  <h2><span>📋</span> 剪贴板历史</h2>
  <span id="count">0 条</span>
  <button id="clearBtn">🗑 清空</button>
</div>
<div class="list" id="list">
  <div class="empty"><div class="icon">📋</div>暂无剪贴板记录<br><span style="font-size:11px">复制文本或图片即可自动记录</span></div>
</div>
<div class="toast" id="toast"></div>
<!-- 图片预览弹窗 -->
<div class="preview-overlay" id="previewOverlay">
  <button class="preview-close" id="previewClose">✕</button>
  <img id="previewImg" src="">
  <button class="preview-copy" id="previewCopy">📋 复制到剪贴板</button>
</div>
<script>
const list=document.getElementById('list'),count=document.getElementById('count'),toast=document.getElementById('toast');
const overlay=document.getElementById('previewOverlay'),previewImg=document.getElementById('previewImg');

function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

function showToast(msg){
  toast.textContent=msg;toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'),1500);
}

// 图片预览
function openPreview(imageData){
  previewImg.src=imageData;
  overlay.classList.add('show');
  document.getElementById('previewCopy').onclick=async()=>{
    await window.electronAPI.writeClipboardImage(imageData);
    showToast('✅ 已复制图片');
  };
}
function closePreview(){
  overlay.classList.remove('show');
  previewImg.src='';
}
overlay.addEventListener('click',e=>{if(e.target===overlay)closePreview()});
document.getElementById('previewClose').addEventListener('click',closePreview);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closePreview()});

async function refresh(){
  const history=await window.electronAPI.getClipboardHistory();
  count.textContent=history.length+' 条';
  list.innerHTML='';
  if(!history||history.length===0){
    list.innerHTML='<div class="empty"><div class="icon">📋</div>暂无剪贴板记录<br><span style="font-size:11px">复制文本或图片即可自动记录</span></div>';
    return;
  }
  history.forEach((item,index)=>{
    const d=new Date(item.time);
    const ts=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
    const date=String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const div=document.createElement('div');
    div.className='item';
    if(item.type==='image'){
      div.innerHTML='<img class="thumb" src="'+item.imageData+'"><div class="content"><div class="text">🖼 图片</div><div class="time">'+date+' '+ts+'</div></div><button class="del" data-i="'+index+'">×</button>';
      // 点击缩略图：放大预览
      div.querySelector('.thumb').addEventListener('click',e=>{
        e.stopPropagation();
        openPreview(item.imageData);
      });
      // 点击内容区：复制图片到剪贴板
      div.querySelector('.content').addEventListener('click',async()=>{
        await window.electronAPI.writeClipboardImage(item.imageData);
        showToast('✅ 已复制图片');
      });
    }else{
      div.innerHTML='<div class="content"><div class="text">'+escapeHtml(item.text)+'</div><div class="time">'+date+' '+ts+'</div></div><button class="del" data-i="'+index+'">×</button>';
      div.querySelector('.content').addEventListener('click',async()=>{
        await window.electronAPI.writeClipboard(item.text);
        showToast('✅ 已复制');
      });
    }
    // 删除
    div.querySelector('.del').addEventListener('click',async(e)=>{
      e.stopPropagation();
      await window.electronAPI.deleteClipboardItem(index);
      await refresh();
    });
    list.appendChild(div);
  });
}

window.electronAPI.onClipboardUpdated(async()=>{await refresh()});

document.getElementById('clearBtn').addEventListener('click',async()=>{
  if(confirm('确定清空所有剪贴板记录？')){
    await window.electronAPI.clearClipboardHistory();
    await refresh();
  }
});

refresh();
</script></body></html>`;

// ====== 生命周期 ======
console.log('[启动] 平台:', process.platform, '架构:', process.arch, '版本:', app.getVersion());
console.log('[启动] 应用路径:', app.getAppPath());
console.log('[启动] 资源路径:', path.join(__dirname, 'index.html'));

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  console.error('[致命错误]', err.message, err.stack);
  dialog.showErrorBox('启动失败', err.message + '\n\n' + (err.stack || '').split('\n').slice(0, 3).join('\n'));
});

app.whenReady().then(() => {
  console.log('[启动] app.whenReady 完成');
  try {
    createWindow();
    console.log('[启动] 窗口创建成功');
    startClipboardWatcher();
    console.log('[启动] 剪贴板监控已启动');
    globalShortcut.register('CommandOrControl+Shift+F', () => { if (mainWindow) mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); });
    console.log('[启动] 全局快捷键已注册');
  } catch (err) {
    console.error('[启动失败]', err.message, err.stack);
    dialog.showErrorBox('启动失败', err.message);
  }
}).catch(err => {
  console.error('[启动失败] app.whenReady 异常:', err.message);
  dialog.showErrorBox('启动失败', err.message);
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => { console.log('[退出] 应用正在退出'); globalShortcut.unregisterAll(); });
app.on('activate', () => { console.log('[激活]'); if (!mainWindow) createWindow(); });

// ====== 开机自启动 ======
ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-auto-launch', (_, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: isWin ? process.execPath : undefined,
  });
  return app.getLoginItemSettings().openAtLogin;
});

// ====== 主题管理 ======
let currentTheme = 'light';
ipcMain.handle('get-theme', () => currentTheme);
ipcMain.handle('set-theme', (_, theme) => {
  currentTheme = theme;
  // 通知所有工具窗口主题变化
  Object.values(toolWindows).forEach(w => {
    try { if (!w.isDestroyed()) w.webContents.send('theme-changed', theme); } catch(e) {}
  });
  return theme;
});
