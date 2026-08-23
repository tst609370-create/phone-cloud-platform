import http from "node:http";

const listenHost = "127.0.0.1";
const listenPort = 18084;
const upstreamHost = "127.0.0.1";
const upstreamPort = 18083;
const routerHost = "192.168.31.1";

const server = http.createServer((request, response) => {
  const headers = { ...request.headers, host: routerHost };
  delete headers.connection;

  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;

      if (responseHeaders.location) {
        responseHeaders.location = responseHeaders.location.replace(
          /^https?:\/\/192\.168\.31\.1(?=\/|$)/i,
          `http://${listenHost}:${listenPort}`,
        );
      }

      if (Array.isArray(responseHeaders["set-cookie"])) {
        responseHeaders["set-cookie"] = responseHeaders["set-cookie"].map((cookie) =>
          cookie.replace(/;\s*Domain=192\.168\.31\.1/gi, ""),
        );
      }

      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end(`小米路由器连接失败：${error.message}`);
  });

  request.pipe(upstream);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(listenPort, listenHost, () => {
  console.log(`http://${listenHost}:${listenPort}`);
});
