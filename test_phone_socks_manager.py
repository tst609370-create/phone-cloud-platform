import socket
import socketserver
import threading
import unittest

from phone_socks_manager import (
    Gateway,
    frp_config,
    parse_frp_token,
    parse_adb_devices,
    recv_exact,
    socks_connect,
    standard_accounts,
)


class EchoHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.sendall(self.request.recv(1024))


class FakeUpstreamHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.assert_bytes(b"\x05\x01\x00")
        self.request.sendall(b"\x05\x00")
        head = recv_exact(self.request, 4)
        self.assertEqual(head[:3], b"\x05\x01\x00")
        if head[3] == 1:
            host = socket.inet_ntoa(recv_exact(self.request, 4))
        elif head[3] == 3:
            host = recv_exact(self.request, recv_exact(self.request, 1)[0]).decode()
        else:
            raise AssertionError("unexpected address type")
        port = int.from_bytes(recv_exact(self.request, 2), "big")
        with socket.create_connection((host, port), timeout=3) as target:
            self.request.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
            target.sendall(self.request.recv(1024))
            self.request.sendall(target.recv(1024))

    def assert_bytes(self, expected):
        self.assertEqual(recv_exact(self.request, len(expected)), expected)

    def assertEqual(self, left, right):
        if left != right:
            raise AssertionError(f"{left!r} != {right!r}")


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ManagerTests(unittest.TestCase):
    def test_parse_adb_devices(self):
        output = """List of devices attached
ABC device product:shiba model:Pixel_8 device:shiba
XYZ unauthorized usb:1-2
"""
        self.assertEqual([(d.serial, d.model) for d in parse_adb_devices(output)], [("ABC", "Pixel 8")])

    def test_standard_formats(self):
        plain, uri = standard_accounts("1.2.3.4", 21001, "phone", "safe pass")
        self.assertEqual(plain, "1.2.3.4:21001:phone:safe pass")
        self.assertEqual(uri, "socks5://phone:safe%20pass@1.2.3.4:21001")

    def test_frp_config(self):
        config = frp_config("vps.example", 7000, "secret", 1080, 21001, "ABC")
        self.assertIn('serverAddr = "vps.example"', config)
        self.assertIn("remotePort = 21001", config)
        self.assertIn('auth.token = "{{ .Envs.PHONE_SK5_FRP_TOKEN }}"', config)
        self.assertNotIn("secret", config)

    def test_parse_frp_token(self):
        self.assertEqual(parse_frp_token('bindPort = 7000\nauth.method = "token"\nauth.token = "secret"\n'), "secret")

    def test_authenticated_gateway_relays(self):
        echo = ThreadingServer(("127.0.0.1", 0), EchoHandler)
        upstream = ThreadingServer(("127.0.0.1", 0), FakeUpstreamHandler)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (echo, upstream)]
        for thread in threads:
            thread.start()
        gateway = Gateway(0, upstream.server_address[1], "user", "pass")
        gateway.start()
        port = gateway.server.server_address[1]
        try:
            with socks_connect("127.0.0.1", port, "user", "pass", "127.0.0.1", echo.server_address[1]) as client:
                client.sendall(b"hello")
                self.assertEqual(client.recv(5), b"hello")
        finally:
            gateway.stop()
            echo.shutdown()
            upstream.shutdown()
            echo.server_close()
            upstream.server_close()


if __name__ == "__main__":
    unittest.main()
