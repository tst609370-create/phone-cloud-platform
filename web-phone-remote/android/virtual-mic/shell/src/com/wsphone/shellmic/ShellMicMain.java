package com.wsphone.shellmic;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * Shell-uid microphone injector.
 *
 * <p>Probe mode registers an AudioPolicy loopback for mic capture presets and
 * exits. Serve mode keeps that policy and writes PCM from 127.0.0.1:28257.
 * Status lines on stdout are the contract with the Node bridge
 * ({@code SHELL_MIC_OK}, {@code SHELL_MIC_READY}, {@code SHELL_MIC_NO:reason}).
 * Anything else goes to stderr so it cannot be mistaken for a status line.
 *
 * <p>Port {@code 28257} and frame types must match {@code src/common/micProtocol.ts}.
 */
public final class ShellMicMain {
    static final int PORT = 28257;
    static final int MAX_PAYLOAD = 256 * 1024;

    public static void main(String[] args) {
        String mode = args.length > 0 ? args[0] : "probe";
        PolicyInjector injector = new PolicyInjector();
        try {
            injector.start();
            if ("probe".equals(mode)) {
                byte[] silence = new byte[960];
                injector.write(silence);
                System.out.println("SHELL_MIC_OK");
                System.out.flush();
            } else {
                serve(injector);
            }
        } catch (Throwable thrown) {
            System.out.println("SHELL_MIC_NO:" + sanitize(thrown));
            System.out.flush();
        } finally {
            injector.stop();
        }
        System.exit(0);
    }

    private static void serve(PolicyInjector injector) throws Exception {
        ServerSocket server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
        // Printed only after the port is open, so the host does not connect early.
        System.out.println("SHELL_MIC_READY");
        System.out.flush();
        Socket socket = server.accept();
        socket.setTcpNoDelay(true);
        DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
        boolean active = false;
        try {
            while (true) {
                int type;
                try {
                    type = in.readUnsignedByte();
                } catch (EOFException end) {
                    break;
                }
                int length = in.readInt();
                if (length < 0 || length > MAX_PAYLOAD) {
                    throw new IllegalStateException("bad frame length " + length);
                }
                byte[] payload = new byte[length];
                in.readFully(payload);
                if (type == 5) {
                    active = true;
                } else if (type == 4) {
                    active = false;
                } else if (type == 3 && active && payload.length > 0) {
                    injector.write(payload);
                }
            }
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
                // already closed
            }
            try {
                server.close();
            } catch (Exception ignored) {
                // already closed
            }
        }
    }

    static String sanitize(Throwable thrown) {
        String name = thrown.getClass().getSimpleName();
        String message = thrown.getMessage() == null ? "" : thrown.getMessage();
        String text = message.length() == 0 ? name : name + ":" + message;
        text = text.replace('\n', ' ').replace('\r', ' ');
        if (text.length() > 160) text = text.substring(0, 160);
        return text;
    }

    private ShellMicMain() {}
}
