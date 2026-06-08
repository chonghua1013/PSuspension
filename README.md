# 🫧 桌面悬浮球 (PSuspension)

> 一个轻量、高效的桌面悬浮球工具，集成了日常工作和开发中常用的快捷工具。

<p align="center">
  <img src="assets/icon.png" alt="悬浮球图标" width="128">
</p>

## ✨ 功能特性

点击悬浮球展开面板，一键启动各种实用工具：

| 分类 | 工具 | 说明 |
|------|------|------|
| 🖥 屏幕工具 | **截图** | 区域截图，自动复制到剪贴板 |
| 🖥 屏幕工具 | **取色器** | 提取屏幕任意位置的颜色值（HEX/RGB） |
| 📋 办公工具 | **剪贴板** | 自动记录剪贴板历史，支持文本和图片 |
| 📋 办公工具 | **记事本** | 快速记录文本，自动保存 |
| 📋 办公工具 | **计算器** | 简易科学计算器，支持键盘输入 |
| 📋 办公工具 | **到期提醒** | 到期日提醒 + 周期提醒，到期自动弹系统通知 |
| 📁 文件工具 | **文件筛选** | 按日期范围筛选并批量复制文件 |
| 📊 表格工具 | **悬浮表格** | 类 Excel 表格，支持粘贴、拖拽填充，常驻桌面 |
| 🌐 翻译工具 | **翻译** | 基于百度翻译 API，支持多语言互译 |
| 🔧 开发工具 | **时间戳转换** | 时间戳与日期时间相互转换 |
| 🔧 开发工具 | **JSON 查看器** | JSON 格式化、树形展开/收起 |
| ⚙️ 系统工具 | **系统信息** | 查看 CPU、内存等系统状态 |

### 其他特性

- 🎨 **深色/浅色主题** 一键切换
- 🚀 **开机自启动** 支持
- ⌨️ **快捷键** 快速调用各工具
- 🔄 **全局快捷键** `Cmd/Ctrl+Shift+Z` 显示/隐藏悬浮球
- 🖥️ **多显示器** 支持
- 🍎 **macOS & Windows & Linux** 跨平台兼容

## 📸 使用截图

<table>
  <tr>
    <td><img src="image.png" alt="悬浮球面板展开" width="400"></td>
    <td><img src="image.png" alt="工具使用场景" width="400"></td>
  </tr>
  <tr>
    <td align="center">悬浮球展开面板</td>
    <td align="center">工具使用场景</td>
  </tr>
</table>

## 🛠 技术栈

- **框架**: [Electron](https://www.electronjs.org/) 28
- **构建**: [electron-builder](https://www.electron.build/)
- **翻译 API**: 百度翻译开放平台
- **主题**: CSS 变量 + localStorage 持久化

## 📦 安装与运行

### 环境要求

- Node.js >= 18
- npm >= 9

### 开发模式

```bash
# 克隆项目
git clone https://github.com/yourusername/PSuspension.git
cd PSuspension

# 安装依赖（国内用户推荐配置镜像）
npm install

# 启动应用
npm start
```

> 💡 项目已配置 `.npmrc` 使用国内镜像加速 Electron 二进制文件下载。

### 构建安装包

```bash
# macOS (ARM64 + x64)
npm run build:mac

# Windows (x64)
npm run build:win

# 全平台构建
npm run build:all
```

构建产物在 `dist/` 目录下。

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl + Shift + S` | 截图 |
| `Cmd/Ctrl + Shift + C` | 取色器 |
| `Cmd/Ctrl + Shift + N` | 记事本 |
| `Cmd/Ctrl + Shift + K` | 计算器 |
| `Cmd/Ctrl + Shift + T` | 翻译 |
| `Cmd/Ctrl + Shift + U` | 时间戳转换 |
| `Cmd/Ctrl + Shift + Z` | 全局显示/隐藏悬浮球 |
| `Cmd/Ctrl + F` | 搜索工具（面板展开时） |
| `Esc` | 收起面板 |

> Windows 上 `Cmd` 对应 `Ctrl` 键。

## 📁 项目结构

```
PSuspension/
├── main.js          # Electron 主进程（窗口管理、IPC、工具实现）
├── index.html       # 渲染进程（悬浮球 UI + 工具面板）
├── preload.js       # 预加载脚本（安全暴露 IPC API）
├── reminder.html    # 到期提醒窗口（到期日/周期提醒管理）
├── package.json     # 项目配置与构建脚本
├── config.json      # API 密钥配置（不提交到 Git）
├── .npmrc           # npm 镜像配置
└── assets/          # 图标与静态资源
```

## 🔧 配置说明

### 翻译 API

项目使用百度翻译开放平台 API。密钥存放在 `config.json` 中，该文件已加入 `.gitignore`，不会提交到仓库。

首次使用时，复制并编辑配置文件：

```bash
# 编辑 config.json，填入你的密钥
{
  "baiduTranslate": {
    "appid": "你的APP ID",
    "key": "你的密钥"
  }
}
```

### 开机自启动

在面板底部点击「开机启动」开关即可启用或禁用。

## 📄 License

MIT

---

<p align="center">Made with ❤️ and Electron</p>
