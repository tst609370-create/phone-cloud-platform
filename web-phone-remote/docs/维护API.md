# 维护 API（给 AI / 脚本用）

## 开通
1. 打开管理后台 → 左侧「AI 维护」→「生成新密钥」，密钥只显示一次（库里只存哈希，不入仓库）。
2. 点「复制说明」，连同密钥一起发给 AI。重新生成或「停用」后旧密钥立即失效。

## 用法
每个请求带请求头 `Authorization: Bearer <密钥>`（或 `X-Maint-Key`）。带有效密钥时全部 `/api/*` 按管理员放行，不需要浏览器 cookie。
完整接口清单运行中可取：`GET /api/maint/help`（内容在 `src/server/api/MaintApi.ts` 的 `MAINT_HELP`）。

```bash
curl -H "Authorization: Bearer $KEY" https://<公网地址>/api/maint/status
curl -H "Authorization: Bearer $KEY" "https://<公网地址>/api/maint/logs?file=node.log&lines=200&grep=error"
curl -H "Authorization: Bearer $KEY" -X POST https://<公网地址>/api/maint/adb -d '{"action":"reconnect","device":"<序列号>"}'
curl -H "Authorization: Bearer $KEY" -X POST https://<公网地址>/api/maint/restart
```

## 说明
- 维护接口：状态（版本、前端 UI_VERSION、adb 设备）、日志（日志目录下 *.log 末尾+关键字过滤）、adb（devices/shell/reconnect/reboot/connect/disconnect/restart-server）、重启服务。
- 重启服务：有启动器托管时 exit(75)；Windows 一键安装（run-node.cmd 不循环）先起一个脱离的小进程，等旧进程退出后用同样参数重新拉起，约 10 秒恢复；不杀 adb，网络手机不掉线。
- 没密钥时：登录模式需管理员会话；开放模式只允许本机访问。
