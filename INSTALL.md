# 天市 v0.0.2 · 安装与发布

## 给朋友安装（推荐）

发送本次构建的 `dsh-tianshi-0.0.2.tgz`，不用发送整个工程。

已将 dsh 加入 PATH 时：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-tianshi-0.0.2.tgz
```

macOS 的 Harness 内置 CLI：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /absolute/path/dsh-tianshi-0.0.2.tgz
```

路径含空格请加引号。profile 应选对方实际使用的配置；桌面常见为 desktop。Windows/Linux 使用自己的 dsh CLI 路径，以上 macOS 路径不适用。

安装后完全退出 Harness 再打开。CLI 会添加依赖并登记 bundle；随后检查侧栏「天市」入口、悬浮球，以及当前应用端口下的 `/api/tianshi/health`。健康检查只证明插件加载，不保证上游行情和模型服务均可用。

## 兼容环境

- 插件声明的 DSH 最低版本为 `>=0.1.1-rc.1`；需要 webServer、llm 和浏览器 slots 服务。未逐一验证所有历史版本，建议使用较新的桌面版。
- Node.js 20+；桌面版通常自带运行时。
- AI分析沿用安装者的Harness默认模型和凭据，插件不赠送模型额度或密钥。

## ETF跟踪器（可选）

公开包不携带开发者的分享码。安装者有权访问数据来源时，可创建：

```text
~/.dsh/tianshi-data/tracker.json
```

内容：

```json
{"sharecode":"YOUR_OWN_SHARE_CODE"}
```

也可在启动应用的进程环境设置 `TIANSHI_TRACKER_SHARECODE`；若使用 `TIANSHI_ROOT`，配置文件应在该目录内。macOS Finder启动不会自动继承终端环境，桌面使用配置文件通常更直接。建议文件权限设为仅本人可读。未配置时只影响ETF观察，不影响普通个股功能。

## 隐私与数据

详见 [PRIVACY.md](PRIVACY.md)。尤其注意：

- 持仓与交易记录存本机浏览器，但端口变化可能让旧记录不可见；当前没有自动迁移。
- 点击AI分析会将行情和持仓成本等分析上下文发送给你配置的模型服务。
- 普通行情查询仍会访问腾讯财经、东方财富等第三方服务。

## 更新与卸载

更新：安装新的tgz并完全退出重开。发布后的每次更新应提升版本号，不要反复用同一版本覆盖。

```bash
dsh plugin --profile desktop remove dsh-tianshi
```

卸载不会自动删除本地记录和行情证据，请按需要自行备份或清理。

## 发布到 npm（可选，尚未代为发布）

维护者在工程根目录构建后，从生成的自包含目录发布；不要直接发布源码 plugin 目录，因为它引用工程外的分析模块。

```bash
node scripts/build-plugin.mjs --pack
cd dist/dsh-tianshi
npm pack --dry-run
npm login
npm publish --access public
```

需先确认npm包名未被别人占用；不保证 `dsh-tianshi` 当前可注册。若被占用，选择你自己的作用域包名，并同步包清单及bundle引用，重新测试后发布。npm平台可能要求2FA或可信发布设置，以发布时提示为准。之后用户可执行 `dsh plugin --profile desktop add <实际发布包名>`。

## GitHub Release（无需npm）

新建仓库并上传已脱敏的源码；发布Release时只附构建出的tgz和SHA-256摘要。**不要直接公开当前开发仓库的完整历史**：历史提交曾包含分享码，文档、截图和样例可能包含个人路径或持仓。若需要公开源码，另做干净导出并审查再推送；不要把整个工作目录打zip。保留MIT许可证与第三方声明，数据服务使用权另行遵守。

仅供研究学习，不构成投资建议；来源可能延迟、缺失或中断，不保证分析准确率或投资回报。
