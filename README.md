# TaskPaste

截图快速生成 TODO 的本地工作台。包含日历、紧急任务、可拖拽画布、列表和看板、截图粘贴与视觉模型识别、快捷入口以及数据备份。

## 开发

要求 Node.js 22.13 或更新版本。

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`。前端开发服务会将 `/api` 转发到本地服务 `127.0.0.1:4317`。

## 生产运行

```bash
npm run build
npm start -- --no-open
```

CLI 支持 `--port 4317`、`--data-dir /path/to/data`、`--no-open` 和 `--help`。默认数据目录仍为 `~/.ai-todo/`，可复制完整目录迁移数据。发布到 npm 后可用 `npx taskpaste` 启动。

## 发布到 npm

```bash
npm login
npm test
npm pack --dry-run
npm publish
```

发布前确认 npm 登录账号和包名归属。`prepack` 会在打包或发布时自动生成前端与服务端产物；`npm pack --dry-run` 可核对包内文件。

## 数据与模型

- 任务、布局和快捷入口：`data/ai-todo.sqlite`
- 原始截图：`attachments/screenshots/`
- 模型配置：`config/models.json`，仅在本地服务读取，文件权限设为 `0600`
- 完整备份：设置里导出 JSON，包含任务、快捷入口、纪念日和截图。模型密钥不会导出。

模型接口采用 DeepSeek 官方视觉 API。粘贴或上传时只保存原图；点击“识别任务”后才发送到 DeepSeek。识别结果作为草稿展示，用户确认后创建任务。

### DeepSeek API

在设置中填写 DeepSeek API Key，默认地址为 `https://api.deepseek.com`，默认模型为支持图片输入的 `deepseek-flash`。点击“保存模型配置”后使用“测试连接”验证模型列表和图片请求。API Key 仅由本地服务端使用，不写入前端构建文件，也不随完整备份导出。

DeepSeek 官方 API 需要有效的 API Key。工作台不会自动启动 Gemini-FastAPI 代理；旧任务和截图仍保留在原数据目录。

本地命令快捷入口只执行用户保存的可执行文件绝对路径，不接受网页直接提交命令或参数。
右侧快捷栏中的示例入口首次启动时写入本地数据库。入口可在侧栏新增、查看、编辑和删除；删除示例入口后不会在重启时重新生成。Codex 的本地命令路径需要用户在编辑入口时配置。

## 当前范围

日历显示农历、公历与农历节日、个人纪念日和周末。2025、2026 年放假与调休安排来自国务院办公厅通知，保存在 `src/holiday-schedules/2025.json` 和 `src/holiday-schedules/2026.json`；其他年份仅按周末标色，不推断官方调休。后续年份可按相同格式增加数据文件。自由画布保存任务坐标并在窗口缩小时限制横向位置；当前不做卡片碰撞避让。备份恢复前会写入本地快照。
