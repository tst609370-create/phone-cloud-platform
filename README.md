# 手机 SK5 管理器

Windows 通过 USB/ADB 选择一部 Android 手机，把该手机的 4G/5G 出口转换成带账号密码的 SOCKS5，并可通过 FRP 提供给远程云手机。

## 使用

1. 双击 `启动手机SK5.cmd`。
2. 选择手机，点击“安装手机端”；在手机上授权，关闭 Auth，启用移动数据并点击电源。
3. 点击“启动本机 SK5”。
4. 如需云手机访问，填写现有 FRP 服务器、公网端口和 SSH 密钥，下载官方 frpc 后启动公网映射。客户端通过 SSH 隧道连接服务器 FRP 控制端口；Token 只读入内存并通过 FRP 环境变量传递，不显示、不写入配置文件。
5. 点击“一键检测”，成功后复制 `IP:端口:用户名:密码`。

检测会通过 SOCKS5 获取真实出口 IP，再显示国家、城市、ASN、运营商、网络类型、风险分和延迟。健康度使用 proxycheck.io 匿名免费额度（当前为每天 100 次），无需购买。

手机端复用 MIT 开源的 [DataProxy](https://github.com/Sir-MmD/dataproxy)，公网映射复用 Apache-2.0 开源的 [FRP](https://github.com/fatedier/frp)。用户名、密码和 FRP Token 不会保存；关闭程序后临时 FRP 配置会删除。

当前版本支持 SOCKS5 `CONNECT`（TCP）。多数浏览器、云手机及代理检测场景均使用 TCP；UDP 转发未包含在首版。

## 验证

```powershell
python -m unittest -v
```
