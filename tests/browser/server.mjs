import http from "node:http";

const host = "127.0.0.1";
const port = 4179;
const page = "<!doctype html><html><head><meta charset=\"utf-8\"><title>P3D2 browser harness</title></head><body>P3D2 test-only browser harness</body></html>";

const server = http.createServer((request, response) => {
  if (request.url !== "/") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(page);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", closeServer);
process.once("SIGTERM", closeServer);
server.listen(port, host);
