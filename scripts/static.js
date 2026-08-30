import httpServer from "http-server";

// 3002：常规开发（页面 + SW 源）
// 3003：独立 origin，供 dev-bridge 等会污染 origin 状态的测试使用
const PORTS = [3002, 3003];
const servers = [];

for (const port of PORTS) {
  const server = httpServer.createServer({
    root: "./",
    cache: -1,
    cors: true,
  });
  server.listen(port);
  servers.push(server);
  console.log(`Static server started on http://localhost:${port}`);
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down static servers...");
  let remaining = servers.length;
  if (remaining === 0) process.exit(0);
  for (const server of servers) {
    server.close(() => {
      remaining -= 1;
      if (remaining === 0) process.exit(0);
    });
  }
  // Force exit after 3s if server.close() hangs (e.g. keep-alive connections)
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
