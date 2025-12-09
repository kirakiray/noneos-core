#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 设置端口
const PORT = process.env.PORT || 3002;

// MIME 类型映射
const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".woff": "application/font-woff",
  ".ttf": "application/font-ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "application/font-otf",
  ".wasm": "application/wasm",
};

// 异步读取文件函数
async function readFile(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return content;
  } catch (error) {
    throw error;
  }
}

// 检查文件是否存在
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 处理请求的异步函数
async function handleRequest(req, res) {
  console.log(`${req.method} ${req.url}`);

  try {
    // 解析请求的文件路径
    let filePath = path.join(
      __dirname,
      "..",
      req.url === "/" ? "index.html" : req.url
    );

    // 获取文件扩展名
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || "application/octet-stream";

    // 检查文件是否存在
    const exists = await fileExists(filePath);
    
    if (!exists) {
      // 文件不存在，尝试返回 404 页面
      try {
        const content = await readFile(path.join(__dirname, "..", "404.html"));
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content, "utf-8");
      } catch {
        // 如果没有自定义 404 页面，返回默认 404
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>404 Not Found</h1><p>The requested file could not be found.</p>",
          "utf-8"
        );
      }
      return;
    }

    // 文件存在，读取并返回
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content, "utf-8");
  } catch (error) {
    // 处理其他错误
    console.error("Server Error:", error);
    res.writeHead(500);
    res.end(`Server Error: ${error.message}`);
  }
}

// 创建服务器
const server = http.createServer(async (req, res) => {
  await handleRequest(req, res);
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`Static server running at http://localhost:${PORT}/`);
});