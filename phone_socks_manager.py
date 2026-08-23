from __future__ import annotations

import hashlib
import hmac
import http.client
import io
import json
import os
import queue
import re
import secrets
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import tomllib
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tkinter import END, StringVar, Tk, filedialog, messagebox
from tkinter import ttk
from tkinter.scrolledtext import ScrolledText


APP_NAME = "手机 SK5 管理器"
APP_DIR = Path(os.environ.get("LOCALAPPDATA", tempfile.gettempdir())) / "PhoneSocksManager"
SETTINGS_PATH = APP_DIR / "settings.json"
DATAPROXY_PACKAGE = "com.dataproxy"
DATAPROXY_RELEASE_API = "https://api.github.com/repos/Sir-MmD/dataproxy/releases/latest"
FRP_RELEASE_API = "https://api.github.com/repos/fatedier/frp/releases/latest"
USER_AGENT = "PhoneSocksManager/0.1"


class ManagerError(RuntimeError):
    pass


@dataclass(frozen=True)
class AdbDevice:
    serial: str
    model: str
    state: str = "device"

    @property
    def label(self) -> str:
        return f"{self.model}  [{self.serial}]"


def find_adb() -> str:
    found = shutil.which("adb")
    if found:
        return found
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Android/Sdk/platform-tools/adb.exe"
    return str(candidate) if candidate.exists() else ""


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(settings: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = SETTINGS_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, SETTINGS_PATH)


def parse_adb_devices(output: str) -> list[AdbDevice]:
    devices: list[AdbDevice] = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2 or parts[1] != "device":
            continue
        fields = dict(part.split(":", 1) for part in parts[2:] if ":" in part)
        devices.append(AdbDevice(parts[0], fields.get("model", "Android").replace("_", " ")))
    return devices


def run_process(args: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        args,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        creationflags=flags,
    )
    if check and result.returncode:
        raise ManagerError((result.stderr or result.stdout or "命令执行失败").strip())
    return result


def list_adb_devices(adb: str) -> list[AdbDevice]:
    if not adb or not Path(adb).exists():
        raise ManagerError("未找到 adb.exe，请安装 Android Platform Tools")
    return parse_adb_devices(run_process([adb, "devices", "-l"]).stdout)


def adb(adb_path: str, serial: str, *args: str, timeout: int = 30, check: bool = True):
    return run_process([adb_path, "-s", serial, *args], timeout=timeout, check=check)


def recv_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise ManagerError("连接意外断开")
        chunks.extend(chunk)
    return bytes(chunks)


def read_socks_address(sock: socket.socket, atyp: int) -> bytes:
    if atyp == 1:
        return recv_exact(sock, 4)
    if atyp == 3:
        length = recv_exact(sock, 1)
        return length + recv_exact(sock, length[0])
    if atyp == 4:
        return recv_exact(sock, 16)
    raise ManagerError("不支持的 SOCKS5 地址类型")


def relay(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    for sock in sockets:
        sock.settimeout(None)
    while sockets:
        readable, _, _ = select_sockets(sockets)
        for source in readable:
            target = right if source is left else left
            try:
                data = source.recv(65536)
                if data:
                    target.sendall(data)
                    continue
            except OSError:
                pass
            sockets.remove(source)
            try:
                target.shutdown(socket.SHUT_WR)
            except OSError:
                pass


def select_sockets(sockets: list[socket.socket]):
    import select

    return select.select(sockets, [], [], 60)


def upstream_connect(upstream: tuple[str, int], request: bytes, timeout: float = 15) -> tuple[socket.socket, bytes]:
    sock = socket.create_connection(upstream, timeout=timeout)
    try:
        sock.sendall(b"\x05\x01\x00")
        if recv_exact(sock, 2) != b"\x05\x00":
            raise ManagerError("手机端 SOCKS5 不接受无认证连接，请关闭手机端 Auth")
        sock.sendall(request)
        head = recv_exact(sock, 4)
        address = read_socks_address(sock, head[3])
        response = head + address + recv_exact(sock, 2)
        if head[1] != 0:
            raise ManagerError(f"手机端 SOCKS5 连接目标失败，代码 {head[1]}")
        return sock, response
    except Exception:
        sock.close()
        raise


class SocksGatewayHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        client = self.request
        try:
            version, count = recv_exact(client, 2)
            if version != 5:
                return
            methods = recv_exact(client, count)
            server: SocksGatewayServer = self.server  # type: ignore[assignment]
            auth_required = bool(server.username or server.password)
            method = 2 if auth_required else 0
            if method not in methods:
                client.sendall(b"\x05\xff")
                return
            client.sendall(bytes((5, method)))
            if auth_required and not self._authenticate(server):
                return
            head = recv_exact(client, 4)
            if head[0] != 5 or head[1] != 1:
                client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
                return
            address = read_socks_address(client, head[3])
            port = recv_exact(client, 2)
            upstream, response = upstream_connect(server.upstream, head + address + port)
            with upstream:
                client.sendall(response)
                relay(client, upstream)
        except (OSError, ManagerError) as exc:
            self.server.last_error = str(exc)  # type: ignore[attr-defined]
            return

    def _authenticate(self, server: "SocksGatewayServer") -> bool:
        client = self.request
        if recv_exact(client, 1) != b"\x01":
            return False
        username = recv_exact(client, recv_exact(client, 1)[0]).decode("utf-8", "replace")
        password = recv_exact(client, recv_exact(client, 1)[0]).decode("utf-8", "replace")
        valid = hmac.compare_digest(username, server.username) and hmac.compare_digest(password, server.password)
        client.sendall(b"\x01\x00" if valid else b"\x01\x01")
        return valid


class SocksGatewayServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], upstream: tuple[str, int], username: str, password: str):
        self.upstream = upstream
        self.username = username
        self.password = password
        self.last_error = ""
        super().__init__(address, SocksGatewayHandler)


class Gateway:
    def __init__(self, listen_port: int, upstream_port: int, username: str, password: str):
        self.server = SocksGatewayServer(
            ("127.0.0.1", listen_port), ("127.0.0.1", upstream_port), username, password
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def socks_connect(host: str, port: int, username: str, password: str, target: str, target_port: int) -> socket.socket:
    if len(username.encode()) > 255 or len(password.encode()) > 255:
        raise ManagerError("用户名或密码过长")
    sock = socket.create_connection((host, port), timeout=15)
    try:
        methods = b"\x02" if username or password else b"\x00"
        sock.sendall(b"\x05\x01" + methods)
        response = recv_exact(sock, 2)
        if response == b"\x05\x02":
            user = username.encode()
            pwd = password.encode()
            sock.sendall(b"\x01" + bytes((len(user),)) + user + bytes((len(pwd),)) + pwd)
            if recv_exact(sock, 2) != b"\x01\x00":
                raise ManagerError("SOCKS5 账号或密码错误")
        elif response != b"\x05\x00":
            raise ManagerError("SOCKS5 认证协商失败")
        encoded = target.encode("idna")
        sock.sendall(b"\x05\x01\x00\x03" + bytes((len(encoded),)) + encoded + struct.pack("!H", target_port))
        head = recv_exact(sock, 4)
        read_socks_address(sock, head[3])
        recv_exact(sock, 2)
        if head[1] != 0:
            raise ManagerError(f"SOCKS5 连接失败，代码 {head[1]}")
        return sock
    except Exception:
        sock.close()
        raise


def proxy_public_ip(host: str, port: int, username: str, password: str) -> tuple[str, int]:
    started = time.monotonic()
    raw = socks_connect(host, port, username, password, "api.ipify.org", 443)
    try:
        context = ssl.create_default_context()
        with context.wrap_socket(raw, server_hostname="api.ipify.org") as tls:
            tls.sendall(
                b"GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\nUser-Agent: "
                + USER_AGENT.encode()
                + b"\r\n\r\n"
            )
            response = http.client.HTTPResponse(tls)
            response.begin()
            body = response.read(65536)
            if response.status != 200:
                raise ManagerError(f"IP 检测服务返回 HTTP {response.status}")
    finally:
        raw.close()
    ip = json.loads(body)["ip"]
    return ip, round((time.monotonic() - started) * 1000)


def fetch_json(url: str, timeout: int = 20) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def inspect_ip(ip: str) -> dict:
    result: dict = {"ip": ip}
    try:
        geo = fetch_json(f"https://ipwho.is/{urllib.parse.quote(ip)}")
        if geo.get("success"):
            result.update(
                country=geo.get("country", "未知"),
                country_code=geo.get("country_code", ""),
                region=geo.get("region", ""),
                city=geo.get("city", ""),
                asn=geo.get("connection", {}).get("asn", ""),
                isp=geo.get("connection", {}).get("isp") or geo.get("connection", {}).get("org", ""),
            )
    except Exception as exc:
        result["geo_error"] = str(exc)
    try:
        risk = fetch_json(f"https://proxycheck.io/v3/{urllib.parse.quote(ip)}")
        record = risk.get(ip, {})
        detections = record.get("detections", {})
        network = record.get("network", {})
        result.update(
            network_type=network.get("type", "未知"),
            provider=network.get("provider", ""),
            risk=detections.get("risk"),
            confidence=detections.get("confidence"),
            proxy=detections.get("proxy"),
            vpn=detections.get("vpn"),
            tor=detections.get("tor"),
            hosting=detections.get("hosting"),
        )
    except Exception as exc:
        result["risk_error"] = str(exc)
    return result


def risk_label(score) -> str:
    if not isinstance(score, (int, float)):
        return "未知"
    if score <= 33:
        return "低风险"
    if score <= 66:
        return "中风险"
    return "高风险"


def standard_accounts(host: str, port: int, username: str, password: str) -> tuple[str, str]:
    if any("\n" in value or "\r" in value or ":" in value for value in (username, password)):
        raise ManagerError("用户名和密码不能包含冒号或换行")
    plain = f"{host}:{port}:{username}:{password}"
    uri = f"socks5://{urllib.parse.quote(username, safe='')}:{urllib.parse.quote(password, safe='')}@{host}:{port}"
    return plain, uri


def download_file(url: str, destination: Path, expected_size: int | None = None) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(
        delete=False, dir=destination.parent
    ) as temp:
        shutil.copyfileobj(response, temp)
        temp_path = Path(temp.name)
    try:
        if expected_size is not None and temp_path.stat().st_size != expected_size:
            raise ManagerError("下载文件大小校验失败")
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)
    return destination


def install_dataproxy(adb_path: str, serial: str) -> tuple[str, str]:
    release = fetch_json(DATAPROXY_RELEASE_API)
    asset = next((item for item in release.get("assets", []) if item["name"].endswith(".apk")), None)
    if not asset:
        raise ManagerError("DataProxy 最新版本没有 APK")
    apk = APP_DIR / "downloads" / asset["name"]
    download_file(asset["browser_download_url"], apk, asset.get("size"))
    if not zipfile.is_zipfile(apk):
        raise ManagerError("下载的 APK 文件无效")
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    adb(adb_path, serial, "install", "-r", str(apk), timeout=120)
    adb(adb_path, serial, "shell", "monkey", "-p", DATAPROXY_PACKAGE, "1", check=False)
    return release.get("tag_name", "latest"), digest


def open_dataproxy(adb_path: str, serial: str) -> None:
    if not adb(adb_path, serial, "shell", "pm", "path", DATAPROXY_PACKAGE, check=False).stdout.strip():
        raise ManagerError("手机尚未安装 DataProxy")
    result = adb(
        adb_path, serial, "shell", "monkey", "-p", DATAPROXY_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1", check=False
    )
    if result.returncode:
        raise ManagerError("手机尚未安装 DataProxy")


def download_frpc() -> tuple[Path, str]:
    release = fetch_json(FRP_RELEASE_API)
    assets = release.get("assets", [])
    archive = next((item for item in assets if re.fullmatch(r"frp_.+_windows_amd64\.zip", item["name"])), None)
    checksum_asset = next((item for item in assets if item["name"] == "frp_sha256_checksums.txt"), None)
    if not archive or not checksum_asset:
        raise ManagerError("FRP 最新版本缺少 Windows 文件或校验文件")
    download_dir = APP_DIR / "downloads"
    archive_path = download_file(archive["browser_download_url"], download_dir / archive["name"], archive.get("size"))
    checksum_path = download_file(
        checksum_asset["browser_download_url"], download_dir / checksum_asset["name"], checksum_asset.get("size")
    )
    match = re.search(rf"^([0-9a-fA-F]{{64}})\s+{re.escape(archive['name'])}$", checksum_path.read_text(), re.MULTILINE)
    actual = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if not match or not hmac.compare_digest(match.group(1).lower(), actual):
        raise ManagerError("FRP SHA-256 校验失败")
    destination = APP_DIR / "bin" / "frpc.exe"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as bundle:
        member = next((name for name in bundle.namelist() if name.endswith("/frpc.exe")), None)
        if not member:
            raise ManagerError("FRP 压缩包内没有 frpc.exe")
        destination.write_bytes(bundle.read(member))
    return destination, release.get("tag_name", "latest")


def frp_config(server: str, server_port: int, token: str, local_port: int, remote_port: int, name: str) -> str:
    safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", name)
    lines = [
        f"serverAddr = {json.dumps(server)}",
        f"serverPort = {server_port}",
        "transport.tls.enable = true",
    ]
    if token:
        lines.extend(("auth.method = \"token\"", 'auth.token = "{{ .Envs.PHONE_SK5_FRP_TOKEN }}"'))
    lines.extend(
        (
            "",
            "[[proxies]]",
            f"name = {json.dumps('phone-sk5-' + safe_name)}",
            'type = "tcp"',
            'localIP = "127.0.0.1"',
            f"localPort = {local_port}",
            f"remotePort = {remote_port}",
        )
    )
    return "\n".join(lines) + "\n"


def parse_frp_token(config: str) -> str:
    try:
        token = tomllib.loads(config).get("auth", {}).get("token", "")
    except tomllib.TOMLDecodeError as exc:
        raise ManagerError("服务器 FRP 配置格式无效") from exc
    if not isinstance(token, str) or not token:
        raise ManagerError("服务器 FRP 配置中没有 Token")
    return token


def fetch_frp_token(server: str, ssh_key: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9.-]+", server):
        raise ManagerError("FRP 服务器地址格式无效")
    if not Path(ssh_key).is_file():
        raise ManagerError("未找到 SSH 密钥")
    ssh = shutil.which("ssh")
    if not ssh:
        raise ManagerError("未找到 Windows SSH 客户端")
    result = run_process(
        [
            ssh,
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-i",
            ssh_key,
            f"root@{server}",
            "cat /etc/frps.toml",
        ],
        timeout=15,
    )
    return parse_frp_token(result.stdout)


class FrpProcess:
    def __init__(self, executable: str, config: str, token: str = ""):
        self.config_path = Path(tempfile.mkstemp(prefix="phone-sk5-", suffix=".toml")[1])
        self.config_path.write_text(config, encoding="utf-8")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        environment = os.environ.copy()
        if token:
            environment["PHONE_SK5_FRP_TOKEN"] = token
        self.process = subprocess.Popen(
            [executable, "-c", str(self.config_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
            env=environment,
        )

    def ensure_running(self, seconds: float = 2) -> None:
        time.sleep(seconds)
        if self.process.poll() is not None:
            output = self.process.stdout.read() if self.process.stdout else ""
            raise ManagerError(output.strip() or "frpc 启动失败")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self.process.stdout:
            self.process.stdout.close()
        for _ in range(10):
            try:
                self.config_path.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.1)


class SshTunnel:
    def __init__(self, server: str, ssh_key: str, remote_port: int):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.local_port = probe.getsockname()[1]
        ssh = shutil.which("ssh")
        if not ssh:
            raise ManagerError("未找到 Windows SSH 客户端")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen(
            [
                ssh,
                "-N",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-i",
                ssh_key,
                "-L",
                f"127.0.0.1:{self.local_port}:127.0.0.1:{remote_port}",
                f"root@{server}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        time.sleep(1)
        if self.process.poll() is not None:
            output = self.process.stdout.read() if self.process.stdout else ""
            raise ManagerError(output.strip() or "SSH 隧道启动失败")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self.process.stdout:
            self.process.stdout.close()


class PublicMapping:
    def __init__(self, frp: FrpProcess, tunnel: SshTunnel):
        self.frp = frp
        self.tunnel = tunnel

    def stop(self) -> None:
        self.frp.stop()
        self.tunnel.stop()


class App:
    def __init__(self, root: Tk):
        self.root = root
        self.root.title(APP_NAME)
        self.root.geometry("860x720")
        self.root.minsize(760, 650)
        self.devices: dict[str, AdbDevice] = {}
        self.gateway: Gateway | None = None
        self.frp: PublicMapping | None = None
        self.active_device: AdbDevice | None = None
        self.forwarded_port: int | None = None
        self.task_queue: queue.Queue = queue.Queue()
        self.closing = False
        settings = load_settings()

        self.adb_path = StringVar(value=find_adb())
        self.device_var = StringVar()
        self.phone_port = StringVar(value="1080")
        self.adb_port = StringVar(value="19080")
        self.local_port = StringVar(value="1080")
        self.username = StringVar(value="phone")
        self.password = StringVar(value=secrets.token_urlsafe(10))
        self.frpc_path = StringVar(value=str(APP_DIR / "bin/frpc.exe"))
        self.frp_server = StringVar(value=settings.get("frp_server", ""))
        self.frp_port = StringVar(value=str(settings.get("frp_port", 7000)))
        self.frp_token = StringVar()
        self.ssh_key = StringVar(value=settings.get("ssh_key", str(Path.home() / ".ssh/id_ed25519")))
        self.public_host = StringVar(value=settings.get("public_host", ""))
        self.remote_port = StringVar(value=str(settings.get("remote_port", 21001)))
        self.account = StringVar()
        self._build_ui()
        self.root.after(50, self._drain_tasks)
        self.refresh_devices()
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build_ui(self) -> None:
        root = ttk.Frame(self.root, padding=14)
        root.pack(fill="both", expand=True)

        phone = ttk.LabelFrame(root, text="1. 选择 USB 手机", padding=10)
        phone.pack(fill="x")
        self._row(phone, 0, "ADB", self.adb_path, width=68)
        ttk.Button(phone, text="选择", command=self.choose_adb).grid(row=0, column=2, padx=4)
        ttk.Label(phone, text="手机").grid(row=1, column=0, sticky="w", pady=5)
        self.device_box = ttk.Combobox(phone, textvariable=self.device_var, state="readonly", width=58)
        self.device_box.grid(row=1, column=1, sticky="ew", pady=5)
        ttk.Button(phone, text="刷新", command=self.refresh_devices).grid(row=1, column=2, padx=4)
        buttons = ttk.Frame(phone)
        buttons.grid(row=2, column=1, sticky="w")
        ttk.Button(buttons, text="安装手机端", command=self.install_agent).pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="打开手机端", command=self.open_agent).pack(side="left")
        ttk.Label(phone, text="手机端关闭 Auth，启用移动数据后点电源启动", foreground="#666").grid(
            row=3, column=1, sticky="w", pady=(5, 0)
        )
        phone.columnconfigure(1, weight=1)

        local = ttk.LabelFrame(root, text="2. 本机 SOCKS5", padding=10)
        local.pack(fill="x", pady=10)
        fields = ttk.Frame(local)
        fields.pack(fill="x")
        self._mini_field(fields, "手机端口", self.phone_port, 0)
        self._mini_field(fields, "ADB端口", self.adb_port, 1)
        self._mini_field(fields, "本机端口", self.local_port, 2)
        self._mini_field(fields, "用户名", self.username, 3)
        self._mini_field(fields, "密码", self.password, 4, show="*")
        controls = ttk.Frame(local)
        controls.pack(fill="x", pady=(10, 0))
        ttk.Button(controls, text="启动本机 SK5", command=self.start_local).pack(side="left")
        ttk.Button(controls, text="停止", command=self.stop_local).pack(side="left", padx=6)

        public = ttk.LabelFrame(root, text="3. 公网映射（云手机使用）", padding=10)
        public.pack(fill="x")
        self._row(public, 0, "frpc", self.frpc_path, width=54)
        ttk.Button(public, text="选择", command=self.choose_frpc).grid(row=0, column=2, padx=4)
        ttk.Button(public, text="下载官方版", command=self.download_frpc_ui).grid(row=0, column=3, padx=4)
        self._row(public, 1, "SSH密钥", self.ssh_key, width=54)
        ttk.Button(public, text="选择", command=self.choose_ssh_key).grid(row=1, column=2, padx=4)
        grid = ttk.Frame(public)
        grid.grid(row=2, column=1, columnspan=3, sticky="ew", pady=5)
        self._mini_field(grid, "FRP服务器", self.frp_server, 0, width=18)
        self._mini_field(grid, "控制端口", self.frp_port, 1, width=8)
        self._mini_field(grid, "Token", self.frp_token, 2, width=15, show="*")
        self._mini_field(grid, "公网IP/域名", self.public_host, 3, width=18)
        self._mini_field(grid, "公网端口", self.remote_port, 4, width=8)
        controls = ttk.Frame(public)
        controls.grid(row=3, column=1, columnspan=3, sticky="w")
        ttk.Button(controls, text="启动公网映射", command=self.start_public).pack(side="left")
        ttk.Button(controls, text="停止映射", command=self.stop_public).pack(side="left", padx=6)
        public.columnconfigure(1, weight=1)

        verify = ttk.LabelFrame(root, text="4. 一键验证与复制", padding=10)
        verify.pack(fill="both", expand=True, pady=(10, 0))
        top = ttk.Frame(verify)
        top.pack(fill="x")
        ttk.Entry(top, textvariable=self.account, state="readonly").pack(side="left", fill="x", expand=True)
        ttk.Button(top, text="复制整条", command=self.copy_account).pack(side="left", padx=(6, 0))
        ttk.Button(top, text="复制用户名", command=lambda: self.copy_value(self.username.get(), "用户名")).pack(
            side="left", padx=(6, 0)
        )
        ttk.Button(top, text="复制密码", command=lambda: self.copy_value(self.password.get(), "密码")).pack(
            side="left", padx=6
        )
        ttk.Button(top, text="一键检测", command=self.check_health).pack(side="left")
        self.output = ScrolledText(verify, height=12, font=("Microsoft YaHei UI", 10), state="disabled")
        self.output.pack(fill="both", expand=True, pady=(8, 0))
        self.log("等待启动。已检测到的手机只通过 ADB 选择，不会混用其他手机网络。")

    @staticmethod
    def _row(parent, row: int, label: str, variable: StringVar, width: int = 40):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(parent, textvariable=variable, width=width).grid(row=row, column=1, sticky="ew", pady=4)

    @staticmethod
    def _mini_field(parent, label: str, variable: StringVar, column: int, width: int = 10, show: str = ""):
        frame = ttk.Frame(parent)
        frame.grid(row=0, column=column, padx=(0, 8), sticky="w")
        ttk.Label(frame, text=label).pack(anchor="w")
        ttk.Entry(frame, textvariable=variable, width=width, show=show).pack()

    def log(self, text: str) -> None:
        self.output.configure(state="normal")
        self.output.insert(END, f"[{time.strftime('%H:%M:%S')}] {text}\n")
        self.output.see(END)
        self.output.configure(state="disabled")

    def async_task(self, work, success=None) -> None:
        def runner():
            try:
                result = work()
                self.task_queue.put((success, result, None))
            except Exception as exc:
                self.task_queue.put((None, None, exc))

        threading.Thread(target=runner, daemon=True).start()

    def _drain_tasks(self) -> None:
        while True:
            try:
                success, result, error = self.task_queue.get_nowait()
            except queue.Empty:
                break
            if error:
                self.log(f"失败：{error}")
            elif success:
                try:
                    success(result)
                except Exception as exc:
                    self.log(f"失败：{exc}")
        if not self.closing:
            self.root.after(50, self._drain_tasks)

    def selected_device(self) -> AdbDevice:
        device = self.devices.get(self.device_var.get())
        if not device:
            raise ManagerError("请先选择 USB 手机")
        return device

    def choose_adb(self) -> None:
        path = filedialog.askopenfilename(title="选择 adb.exe", filetypes=[("adb.exe", "adb.exe"), ("全部", "*")])
        if path:
            self.adb_path.set(path)
            self.refresh_devices()

    def refresh_devices(self) -> None:
        self.log("正在刷新 USB 手机…")
        adb_path = self.adb_path.get()

        def done(devices: list[AdbDevice]):
            self.devices = {device.label: device for device in devices}
            self.device_box["values"] = list(self.devices)
            if devices:
                self.device_var.set(devices[0].label)
            self.log(f"检测到 {len(devices)} 部手机：" + "、".join(device.model for device in devices))

        self.async_task(lambda: list_adb_devices(adb_path), done)

    def install_agent(self) -> None:
        try:
            device = self.selected_device()
        except Exception as exc:
            self.log(str(exc))
            return
        adb_path = self.adb_path.get()
        self.log(f"正在为 {device.model} 下载并安装官方 DataProxy…")

        def done(result):
            tag, digest = result
            self.log(f"DataProxy {tag} 安装完成，SHA-256：{digest}")
            self.log("请在手机上授权，然后关闭 Auth 并点击电源启动。")

        self.async_task(lambda: install_dataproxy(adb_path, device.serial), done)

    def open_agent(self) -> None:
        try:
            device = self.selected_device()
            adb_path = self.adb_path.get()
            self.async_task(lambda: open_dataproxy(adb_path, device.serial), lambda _: self.log("已打开手机端"))
        except Exception as exc:
            self.log(str(exc))

    @staticmethod
    def port(value: StringVar, name: str) -> int:
        try:
            port = int(value.get())
        except ValueError as exc:
            raise ManagerError(f"{name}必须是数字") from exc
        if not 1 <= port <= 65535:
            raise ManagerError(f"{name}范围必须是 1-65535")
        return port

    def start_local(self) -> None:
        if self.gateway:
            self.log("本机 SK5 已经运行")
            return
        try:
            device = self.selected_device()
            phone_port = self.port(self.phone_port, "手机端口")
            adb_port = self.port(self.adb_port, "ADB端口")
            local_port = self.port(self.local_port, "本机端口")
            username = self.username.get()
            password = self.password.get()
            adb_path = self.adb_path.get()
            standard_accounts("127.0.0.1", local_port, username, password)
        except Exception as exc:
            self.log(str(exc))
            return
        self.log(f"正在连接 {device.model} 的移动网络…")

        def work():
            try:
                adb(adb_path, device.serial, "forward", "--remove", f"tcp:{adb_port}", check=False)
                adb(adb_path, device.serial, "forward", f"tcp:{adb_port}", f"tcp:{phone_port}")
                probe = socket.create_connection(("127.0.0.1", adb_port), timeout=5)
                with probe:
                    probe.sendall(b"\x05\x01\x00")
                    if recv_exact(probe, 2) != b"\x05\x00":
                        raise ManagerError("手机端代理未运行，或手机端 Auth 没有关闭")
                gateway = Gateway(local_port, adb_port, username, password)
                gateway.start()
                return gateway
            except Exception:
                adb(adb_path, device.serial, "forward", "--remove", f"tcp:{adb_port}", check=False)
                raise

        def done(gateway: Gateway):
            self.gateway = gateway
            self.active_device = device
            self.forwarded_port = adb_port
            self._update_account(public=False)
            self.log(f"本机 SK5 已启动：127.0.0.1:{local_port} → {device.model} 移动网络")

        self.async_task(work, done)

    def stop_local(self) -> None:
        self.stop_public()
        gateway, device, port = self.gateway, self.active_device, self.forwarded_port
        adb_path = self.adb_path.get()
        self.gateway = None
        self.active_device = None
        self.forwarded_port = None
        self.account.set("")

        def work():
            if gateway:
                gateway.stop()
            if device and port:
                adb(adb_path, device.serial, "forward", "--remove", f"tcp:{port}", check=False)

        self.async_task(work, lambda _: self.log("本机 SK5 已停止"))

    def choose_frpc(self) -> None:
        path = filedialog.askopenfilename(title="选择 frpc.exe", filetypes=[("frpc.exe", "frpc.exe"), ("全部", "*")])
        if path:
            self.frpc_path.set(path)

    def choose_ssh_key(self) -> None:
        path = filedialog.askopenfilename(title="选择 SSH 私钥", filetypes=[("SSH私钥", "*"), ("全部", "*")])
        if path:
            self.ssh_key.set(path)

    def download_frpc_ui(self) -> None:
        self.log("正在下载并校验官方 FRP…")

        def done(result):
            path, tag = result
            self.frpc_path.set(str(path))
            self.log(f"FRP {tag} 已下载并通过 SHA-256 校验")

        self.async_task(download_frpc, done)

    def start_public(self) -> None:
        if not self.gateway:
            self.log("请先启动本机 SK5")
            return
        if self.frp:
            self.log("公网映射已经运行")
            return
        try:
            executable = self.frpc_path.get()
            if not Path(executable).exists():
                raise ManagerError("未找到 frpc.exe，可点击“下载官方版”")
            server = self.frp_server.get().strip()
            public_host = self.public_host.get().strip()
            if not server or not public_host:
                raise ManagerError("请填写 FRP 服务器和公网 IP/域名")
            server_port = self.port(self.frp_port, "FRP控制端口")
            token = self.frp_token.get()
            ssh_key = self.ssh_key.get()
            local_port = self.port(self.local_port, "本机端口")
            remote_port = self.port(self.remote_port, "公网端口")
            device_name = self.active_device.serial if self.active_device else "phone"
        except Exception as exc:
            self.log(str(exc))
            return
        self.log("正在建立 FRP 公网映射…")

        def work():
            resolved_token = token or fetch_frp_token(server, ssh_key)
            tunnel = SshTunnel(server, ssh_key, server_port)
            try:
                config = frp_config("127.0.0.1", tunnel.local_port, resolved_token, local_port, remote_port, device_name)
                process = FrpProcess(executable, config, resolved_token)
                process.ensure_running()
            except Exception:
                process.stop() if "process" in locals() else None
                tunnel.stop()
                raise
            return PublicMapping(process, tunnel)

        def done(process: PublicMapping):
            self.frp = process
            save_settings(
                {
                    "frp_server": server,
                    "frp_port": server_port,
                    "ssh_key": ssh_key,
                    "public_host": public_host,
                    "remote_port": remote_port,
                }
            )
            self._update_account(public=True)
            self.log(f"公网 SK5 已启动：{public_host}:{remote_port}")

        self.async_task(work, done)

    def stop_public(self) -> None:
        process = self.frp
        self.frp = None
        if process:
            self.async_task(process.stop, lambda _: self.log("公网映射已停止"))
        if self.gateway:
            self._update_account(public=False)

    def _update_account(self, public: bool) -> None:
        host = self.public_host.get().strip() if public else "127.0.0.1"
        port = self.port(self.remote_port if public else self.local_port, "端口")
        plain, _ = standard_accounts(host, port, self.username.get(), self.password.get())
        self.account.set(plain)

    def copy_account(self) -> None:
        if not self.account.get():
            self.log("没有可复制的账号")
            return
        self.copy_value(self.account.get(), "标准格式：IP:端口:用户名:密码")

    def copy_value(self, value: str, label: str) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(value)
        self.log(f"已复制{label}")

    def check_health(self) -> None:
        try:
            if self.frp:
                host = self.public_host.get().strip()
                port = self.port(self.remote_port, "公网端口")
                label = "公网"
            elif self.gateway:
                host = "127.0.0.1"
                port = self.port(self.local_port, "本机端口")
                label = "本机"
            else:
                raise ManagerError("请先启动 SK5")
            username = self.username.get()
            password = self.password.get()
        except Exception as exc:
            self.log(str(exc))
            return
        self.log(f"正在通过{label} SOCKS5 检测出口 IP 和健康度…")

        def work():
            ip, latency = proxy_public_ip(host, port, username, password)
            details = inspect_ip(ip)
            details["latency"] = latency
            return details

        def done(info: dict):
            score = info.get("risk")
            flags = [name.upper() for name in ("proxy", "vpn", "tor", "hosting") if info.get(name)]
            self.log("检测成功")
            self.log(f"出口 IP：{info['ip']}")
            self.log(
                f"归属：{info.get('country', '未知')} {info.get('region', '')} {info.get('city', '')} | "
                f"ASN：{info.get('asn', '未知')} | 运营商：{info.get('isp') or info.get('provider') or '未知'}"
            )
            self.log(
                f"网络类型：{info.get('network_type', '未知')} | 风险：{score if score is not None else '未知'} "
                f"({risk_label(score)}) | 标记：{','.join(flags) or '无'} | 延迟：{info['latency']}ms"
            )
            if info.get("risk_error"):
                self.log("健康度服务暂时不可用，但 SOCKS5 连通与出口 IP 已验证")

        self.async_task(work, done)

    def close(self) -> None:
        self.closing = True
        if self.frp:
            self.frp.stop()
        if self.gateway:
            self.gateway.server.shutdown()
            self.gateway.server.server_close()
        if self.active_device and self.forwarded_port:
            adb(
                self.adb_path.get(),
                self.active_device.serial,
                "forward",
                "--remove",
                f"tcp:{self.forwarded_port}",
                check=False,
            )
        self.root.destroy()


def main() -> None:
    root = Tk()
    try:
        root.call("tk", "scaling", 1.15)
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
