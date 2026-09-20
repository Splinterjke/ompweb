# ompweb

<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="ompweb logo" />
</p>

<p align="center">
  <strong>面向 <a href="https://github.com/can1357/oh-my-pi">oh-my-pi (omp)</a> 编码智能体的 Web UI 应用。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ru.md">Русский</a>
</p>

ompweb 为你的本地 omp 运行时提供一个浏览器工作区：会话浏览（分支导航与分叉）、基于 omp RPC 协议的实时聊天、模型 / MCP / 技能管理、Git worktree 切换以及丰富的文件预览。

<details>
<summary>📸 我相信图片有时候比文字更能说明问题</summary>

| | |
| :---: | :---: |
| 主工作区<br>![](screenshots/screenshot-main-workspace.png) | 新会话编辑器<br>![](screenshots/new-session-composer.png) |
| 展开的处理详情（工具调用）<br>![](screenshots/chat-expanded-details.png) | 编辑器任务面板<br>![](screenshots/composer-tasks-expanded.png) |
| 斜杠命令菜单<br>![](screenshots/slash-command-popover.png) | 会话信息 / 上下文弹窗<br>![](screenshots/session-info-popover.png) |
| 命令面板<br>![](screenshots/command-palette.png) | Git 图形模态框<br>![](screenshots/gitgraph-commit-log.png) |
| Git 图形 — 提交差异<br>![](screenshots/gitgraph-commit-diff.png) | 文件查看器标签<br>![](screenshots/fileviewer-tab.png) |
| 会话列表（展开）<br>![](screenshots/sidebar-sessions-full.png) | 归档会话浏览器<br>![](screenshots/archived-sessions.png) |
| 资源管理器（悬停 + 引用）<br>![](screenshots/explorer-hover-mention.png) | 子智能体面板（任务）<br>![](screenshots/rightpanel-taskmanager.png) |
| Git 面板（更改的文件）<br>![](screenshots/rightpanel-git.png) | 目标与子智能体中心（展开）<br>![](screenshots/composer-goal-subagents.png) |
| 侧边聊天面板<br>![](screenshots/rightpanel-sidechat.png) | 侧边聊天（空状态）<br>![](screenshots/rightpanel-sidechat-empty.png) |
| 文件面板<br>![](screenshots/rightpanel-files.png) | 聊天小地图悬停提示<br>![](screenshots/minimap-tooltip.png) |
| 服务错误恢复队列<br>![](screenshots/service-error-recovery.png) | 聊天事件动作<br>![](screenshots/chat-event-actions-section.png) |
| 聊天事件动作弹窗<br>![](screenshots/chat-event-actions-modals.png) | 计划器编辑对话框<br>![](screenshots/scheduler-edit-modal.png) |
| 嵌入式终端（打开状态）<br>![](screenshots/embedded-terminal.png) | 主题色板 — 静态<br>![](screenshots/themepalette-static.png) |
| 主题色板 — 流动<br>![](screenshots/themepalette-flowing.png) | 主题色板 — 动效<br>![](screenshots/themepalette-motion.png) |
| 主题色板 — 字体<br>![](screenshots/themepalette-font.png) | 主题色板 — UI 字体缩放<br>![](screenshots/theme-palette-ui-scale-settings.png) |
| 设置 — 界面与行为<br>![](screenshots/settings-interface-behavior.png) | 设置 — 安全与审批<br>![](screenshots/settings-safety-approvals.png) |
| 设置 — AI 模型默认值<br>![](screenshots/settings-ai-model-defaults.png) | 设置 — 智能体与智能<br>![](screenshots/settings-agent-intelligence.png) |
| 设置 — 智能体<br>![](screenshots/settings-agents.png) | 设置 — 扩展与工具<br>![](screenshots/settings-extensions-tools.png) |
| 设置 — OMP 原生<br>![](screenshots/settings-omp-native.png) | 设置 — 远程访问<br>![](screenshots/settings-remote-access.png) |
| 设置 — 技能中心<br>![](screenshots/settings-skill-hub.png) | 设置 — 系统与更新<br>![](screenshots/settings-system-updates.png) |
| 设置 — 搜索<br>![](screenshots/settings-search.png) | 设置 — 诊断与恢复<br>![](screenshots/settings-diagnostics.png) |
| 主题：Light（暖纸）<br>![](screenshots/screenshot-theme-light.png) | 主题：omp 午夜<br>![](screenshots/screenshot-theme-omp-midnight.png) |
| 主题：燕麦拿铁<br>![](screenshots/screenshot-theme-oatmeal-latte.png) | 主题：Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro.png) |
| 主题：Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum.png) | 主题：Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai.png) |
| 主题：单色（Codex）<br>![](screenshots/screenshot-theme-monochrome-codex.png) | 主题：Monokai Pro 日光<br>![](screenshots/screenshot-theme-monokai-pro-light-sun.png) |
| 主题：Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn.png) | 主题：Harbor<br>![](screenshots/screenshot-theme-harbor.png) |
| 主题：Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha.png) | 移动端：Harbor<br>![](screenshots/screenshot-theme-harbor-mobile.png) |
| 主题：Nord Arctic<br>![](screenshots/screenshot-theme-nord.png) | 主题：Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha.png) |
| 主题：OLED Obsidian<br>![](screenshots/screenshot-theme-oled.png) | 主题：Warm Ember<br>![](screenshots/screenshot-theme-dark.png) |
| 主题：Antique Vellum<br>![](screenshots/screenshot-theme-sepia.png) | 主题：Dracula Velvet<br>![](screenshots/screenshot-theme-dracula.png) |
| 主题：Pine Forest<br>![](screenshots/screenshot-theme-pine.png) | 主题：Horizon Navy<br>![](screenshots/screenshot-theme-navy.png) |
| 主题：Monokai Classic<br>![](screenshots/screenshot-theme-monokai.png) | 主题：Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon.png) |
| 主题：Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine.png) | 主题：Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto.png) |
| 主题：Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light.png) | 主题：One Light<br>![](screenshots/screenshot-theme-one-light.png) |
| 主题：One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro.png) | 主题：Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte.png) |
| 主题：Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark.png) | 主题：Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night.png) |
| 主题：Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine.png) | 移动端：Light（暖纸）<br>![](screenshots/screenshot-theme-light-mobile.png) |
| 移动端：Nord Arctic<br>![](screenshots/screenshot-theme-nord-mobile.png) | 移动端：Oatmeal Latte<br>![](screenshots/screenshot-theme-oatmeal-mobile.png) |
| 移动端：Kyoto Matcha<br>![](screenshots/screenshot-theme-matcha-mobile.png) | 移动端：OLED Obsidian<br>![](screenshots/screenshot-theme-oled-mobile.png) |
| 移动端：Monochrome（Codex）<br>![](screenshots/screenshot-theme-codex-mobile.png) | 移动端：Warm Ember<br>![](screenshots/screenshot-theme-dark-mobile.png) |
| 移动端：Antique Vellum<br>![](screenshots/screenshot-theme-sepia-mobile.png) | 移动端：Dracula Velvet<br>![](screenshots/screenshot-theme-dracula-mobile.png) |
| 移动端：Pine Forest<br>![](screenshots/screenshot-theme-pine-mobile.png) | 移动端：Horizon Navy<br>![](screenshots/screenshot-theme-navy-mobile.png) |
| 移动端：Omarchy Monokai<br>![](screenshots/screenshot-theme-omarchy-monokai-mobile.png) | 移动端：Monokai Classic<br>![](screenshots/screenshot-theme-monokai-mobile.png) |
| 移动端：Monokai Pro<br>![](screenshots/screenshot-theme-monokai-pro-mobile.png) | 移动端：Monokai Pro Octagon<br>![](screenshots/screenshot-theme-monokai-pro-octagon-mobile.png) |
| 移动端：Monokai Pro Machine<br>![](screenshots/screenshot-theme-monokai-pro-machine-mobile.png) | 移动端：Monokai Pro Ristretto<br>![](screenshots/screenshot-theme-monokai-pro-ristretto-mobile.png) |
| 移动端：Monokai Pro Spectrum<br>![](screenshots/screenshot-theme-monokai-pro-spectrum-mobile.png) | 移动端：Monokai Pro Light<br>![](screenshots/screenshot-theme-monokai-pro-light-mobile.png) |
| 移动端：Monokai Pro Light Sun<br>![](screenshots/screenshot-theme-monokai-pro-light-sun-mobile.png) | 移动端：omp Midnight<br>![](screenshots/screenshot-theme-omp-mobile.png) |
| 移动端：One Light<br>![](screenshots/screenshot-theme-one-light-mobile.png) | 移动端：One Dark Pro<br>![](screenshots/screenshot-theme-one-dark-pro-mobile.png) |
| 移动端：Catppuccin Latte<br>![](screenshots/screenshot-theme-catppuccin-latte-mobile.png) | 移动端：Catppuccin Mocha<br>![](screenshots/screenshot-theme-catppuccin-mocha-mobile.png) |
| 移动端：Gruvbox Dark<br>![](screenshots/screenshot-theme-gruvbox-dark-mobile.png) | 移动端：Tokyo Night<br>![](screenshots/screenshot-theme-tokyo-night-mobile.png) |
| 移动端：Rosé Pine<br>![](screenshots/screenshot-theme-rose-pine-mobile.png) | 移动端：Rosé Pine Dawn<br>![](screenshots/screenshot-theme-rose-pine-dawn-mobile.png) |
</details>

## 🐳 Docker 运行

本项目主要适配 Docker（Linux）环境运行：仓库根目录的 `docker-compose.yaml` 会构建镜像、挂载代码仓库并映射启动器端口。一条命令即可启动：

```bash
docker compose up -d --build
```

然后打开 [http://127.0.0.1:6767](http://127.0.0.1:6767)（密码见下文「环境变量」）。
注意：compose 文件默认将 `c:/users/dev/.omp` 绑定到容器内的 `/root/.omp` —— 启动容器之前，请将此 `source:` 路径更新为您自己用户的 `.omp` 存储目录（Linux 上为 `~/.omp`，Windows 上为 `c:/users/{user}/.omp`），以便容器使用您已有的凭据、会话与设置。

移动端 Web 版本是一个功能完整的 PWA：将其添加到手机主屏幕即可像原生应用一样使用。
同样支持以独立的 Windows / Linux / macOS 应用形式构建与运行。
欢迎 fork 本项目并在此基础上扩展。

## ⚙️ 端口

启动器会探测 `SIBLING_PORTS = [30177, 30178, 30179]`（硬编码于 `bin/omp-web.js`），`docker-compose.yaml` 已将这三个端口映射进容器。当智能体在容器内启动 dev 服务器、而你需要在宿主机浏览器中访问 / 调试时，请使用这些端口。

## 🔑 默认密码

compose 文件默认设置 `OMP_WEB_PASSWORD=asdf1234` —— 在登录界面使用该密码，或自行覆盖为其他值。

## 🔄 重新构建并重启（挂载仓库时）

当仓库被挂载进容器（compose 默认行为）时，`ompweb-rebuild-restart.sh` 脚本会被注册到 **Script schedulers** 设置中，作为*手动触发*的调度项 —— 当你的智能体修改了源码之后，用它来重新构建并部署 ompweb 十分方便。之后只需刷新页面即可加载新版本。新构建部署完成且 OmpWeb 启动后，界面会弹出通知并提供**刷新页面**按钮。注意：如果同时有 ompweb dev 服务器实例在运行，有时可能导致主实例构建产物过期。

## 🤖 Agents MCP

内置的多智能体 **Agent MCP** 服务器默认处于禁用状态。如果你希望让 OMP 智能体派生并协调不同的智能体，请启用它（Settings → Extensions & Tools → MCP）。

## 🙏 致谢与改进

本项目整合了 `kahme247` 与 `37chengshan` fork 的改进，经过优雅合并，仅保留真正有用的功能；大部分修复由 Splinterjke 提供。主要改进：

- 文件浏览、滚动条异常行为等重大 bug 大部分已解决，不过特意留了一些给你，嘿嘿
- 可配置的上下文压缩（Context Compaction）设置与优先级
- 大量新主题与调色板（Monokai 系列、Omarchy Monokai、Catppuccin、Rosé Pine、Harbor、omp Midnight、Oatmeal Latte 等），修正了表面色 token 并为各主题定制文本选中样式
- Git Graph 弹窗 —— 可视化仓库历史，支持按提交浏览文件 diff
- 改进的 RPC / IPC 通信，包括服务器重启后会话恢复与回合续接
- OmpWeb 重建与重启相关修复：带显式刷新按钮的更新通知、loopback `/api/ui/refresh` 豁免、手动调度项自动注册
- 聊天小地图 / 滚动条改进：全高轨道、渐变强调光束、按轨道高度约束的滑块、更大的悬停提示
- 聊天输入框顺时针渐变边框光束
- 统一、通用的字号设置
- 左侧边栏可展开 / 可拖拽调整大小的分区，以及可调整宽度的侧边栏 / 工作区面板
- 脚本调度功能（间隔、每日、每周、cron、手动）及专属设置面板
- 聊天事件动作 — 由聊天生命周期事件触发的命名自动化（通知、HTTP 请求、bash 命令、定时脚本），载荷中可使用事件数据变量
- 改进的 Skill Hub 与 Agents 设置页面 — Skill Hub 与 Agents 现在不仅显示当前工作区的实例，而是每个工作区的实例
- 更好的新建会话输入框（工作区选择器、加号菜单附件、上下文环）
- 可展开的 thinking 与 detail 块，完整工具输入可内联展开
- 三栏顶栏（中间为工作区 / 会话面包屑）、会话信息浮层、composer 中的 sub-agents 中心
- 移除多余内容，并对布局 / 间距与性能进行清理

## 🛠️ 环境变量

| 变量名 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- |
| `PORT` / `-p` / `--port` | Web 服务监听端口 | `6767` |
| `OMP_WEB_HOSTNAME` / `-H` / `--hostname` | 监听主机地址 | `127.0.0.1` |
| `OMP_WEB_PASSWORD` / `--password` | Web 访问密码（compose 默认：`asdf1234`） | *(未设置即无需密码)* |
| `OMP_WEB_ALLOWED_HOSTS` | 允许访问应用的非回环主机（逗号分隔） | *(空 — 仅回环)* |
| `OMP_WEB_NO_OPEN` | 启动后是否跳过自动打开浏览器 | `0` (`1` 表示不自动打开) |
| `OMP_WEB_OMP_BIN` | 指定 `omp` 二进制可执行文件的绝对路径 | 自动从 `PATH` 环境变量中查找 |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 兼容的语音转文字接口 URL | _无（默认禁用）_ |
| `OMP_WEB_STT_KEY` | STT 接口对应的 API Key | _无_ |
| `OMP_WEB_STT_MODEL` | STT 接口的模型名称 | _无_ |
| `PI_CODING_AGENT_DIR` | OMP 数据与配置存放根目录 | `~/.omp/agent` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 后端请求所使用的代理配置 | *(系统默认)* |

## 📄 开源协议

本项目遵循 [MIT 许可证](./LICENSE)。
