//! 管理 HTTP 接口：独立的轻量 HTTP 服务，供管理端（ofa.js 应用）调用。
//!
//! 设计要点：
//! - 与 WebSocket 主服务完全分离，监听独立端口（默认 127.0.0.1:8082，由 nginx 反代对外）
//! - 所有命令统一 POST，body 为 JSON（与 AdminCommand 同构），路径为配置的自定义前缀
//! - 鉴权：Authorization: Bearer <admin_token>，token 通过 SHA-256 摘要做常量时间比较
//! - 路径错误 / 方法错误 / token 错误一律返回 404，探测者无法区分
//! - 暴力破解防护：按来源 IP 记录失败次数，失败越多响应前延迟越长

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::admin::{self, AdminCommand};
use crate::handler::AppState;

/// 请求头最大字节数（请求行 + 头部）
const MAX_HEADER_BYTES: usize = 8 * 1024;
/// 请求 body 最大字节数
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 失败计数窗口（秒）
const FAIL_WINDOW_SECS: u64 = 60;
/// 窗口内最大失败次数，超过后每次失败额外延迟 2 秒
const FAIL_LIMIT: u32 = 10;
/// 单次失败的基础延迟
const FAIL_BASE_DELAY: Duration = Duration::from_millis(200);
/// 单次失败的最大延迟
const FAIL_MAX_DELAY: Duration = Duration::from_secs(5);

/// 按来源 IP 的鉴权失败计数器
struct FailCounter {
    fails: DashMap<String, (u32, u64)>, // ip -> (count, window_start_ms)
}

impl FailCounter {
    fn new() -> Self {
        Self { fails: DashMap::new() }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 记录一次失败，返回应延迟的时长
    fn record_failure(&self, ip: &str) -> Duration {
        let now = Self::now_ms();
        let count = {
            let mut entry = self.fails.entry(ip.to_string()).or_insert((0, now));
            if now - entry.1 > FAIL_WINDOW_SECS * 1000 {
                entry.1 = now;
                entry.0 = 0;
            }
            entry.0 += 1;
            entry.0
        };
        if count > FAIL_LIMIT {
            FAIL_MAX_DELAY
        } else {
            FAIL_BASE_DELAY * count.min(8)
        }
    }

    /// 清除来源的失败计数（鉴权成功后调用）
    fn clear(&self, ip: &str) {
        self.fails.remove(ip);
    }
}

/// 常量时间比较两个等长字节切片
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 校验 Bearer token：比较 SHA-256 摘要而非原文（摘要等长，配合 ct_eq 实现常量时间）
fn verify_token(provided: &str, expected: &str) -> bool {
    let h1 = Sha256::digest(provided.as_bytes());
    let h2 = Sha256::digest(expected.as_bytes());
    ct_eq(&h1, &h2)
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>, // key 已转小写
    body: Vec<u8>,
}

/// 读取并解析一个 HTTP/1.1 请求（不支持 keep-alive，处理完即关闭连接）
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut tmp = [0u8; 4096];

    // 读到头部结束（\r\n\r\n）或超限
    let header_end = loop {
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Ok(None);
        }
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header_str.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_ascii_lowercase();
            let value = line[colon + 1..].trim().to_string();
            headers.insert(key, value);
        }
    }

    // 读取 body
    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Ok(None);
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(None);
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);

    Ok(Some(Request { method, path, headers, body }))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// CORS 响应头：管理端（ofa.js 应用）通常经 nginx 与接口同源部署，
/// 本地开发/测试场景下页面与管理接口端口不同，需要放行跨域。
/// 仅对命中 admin_base_path 的请求返回（错误路径的响应不带任何 CORS 特征，
/// 与不存在的路径完全一致）；鉴权仍由 Bearer token 把关。
const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Max-Age: 86400\r\n";

async fn write_response(stream: &mut TcpStream, status: u16, reason: &str, body: &str, cors: bool) -> std::io::Result<()> {
    let cors_block = if cors { CORS_HEADERS } else { "" };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        cors_block,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
}

/// 处理单个管理 HTTP 连接
async fn handle_admin_conn(mut stream: TcpStream, peer: SocketAddr, state: Arc<AppState>, fails: Arc<FailCounter>) {
    // 慢连接防护：整个请求读取限时 10 秒，超时放弃
    let req = match tokio::time::timeout(Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(Some(r))) => r,
        _ => {
            let _ = write_response(&mut stream, 404, "Not Found", "{}", false).await;
            return;
        }
    };

    let ip = peer.ip().to_string();

    // 统一 404 响应体；路径命中后的 404（方法/Token 错）带 CORS 头，
    // 路径未命中的 404 不带——响应特征与不存在的路径完全一致
    async fn not_found(s: &mut TcpStream, cors: bool) {
        let _ = write_response(s, 404, "Not Found", "{}", cors).await;
    }

    // 1. 路径检查：必须精确匹配配置的 base path；未命中时与不存在的路径行为一致
    //    （404 且不带 CORS 头），不泄露管理接口的位置
    let expected_path = &state.config.admin_base_path;
    if req.path != *expected_path {
        not_found(&mut stream, false).await;
        return;
    }

    // 2. OPTIONS 为跨域预检。预检不携带 Authorization 无法鉴权，回 204 + CORS 头；
    //    真实命令仍需 POST 鉴权
    if req.method == "OPTIONS" {
        let resp = format!(
            "HTTP/1.1 204 No Content\r\n{}Content-Length: 0\r\nConnection: close\r\n\r\n",
            CORS_HEADERS
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    // 3. 方法检查：只接受 POST
    if req.method != "POST" {
        not_found(&mut stream, true).await;
        return;
    }

    // 4. Bearer token 校验
    let authorized = state
        .config
        .admin_token
        .as_ref()
        .map(|expected| {
            req.headers
                .get("authorization")
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|provided| verify_token(provided, expected))
                .unwrap_or(false)
        })
        .unwrap_or(false);

    if !authorized {
        let delay = fails.record_failure(&ip);
        tokio::time::sleep(delay).await;
        not_found(&mut stream, true).await;
        return;
    }
    fails.clear(&ip);

    // 5. 解析 AdminCommand 并分发
    let resp = match serde_json::from_slice::<AdminCommand>(&req.body) {
        Ok(cmd) => admin::handle_admin_command(&state, cmd).await,
        Err(e) => {
            let _ = write_response(
                &mut stream,
                400,
                "Bad Request",
                &format!("{{\"status\":\"error\",\"message\":\"Invalid JSON: {}\"}}", e),
                true,
            )
            .await;
            return;
        }
    };

    let body = serde_json::to_string(&resp).unwrap_or_else(|_| "{}".to_string());
    let _ = write_response(&mut stream, 200, "OK", &body, true).await;
}

/// 启动管理 HTTP 服务（仅在配置了 admin_token 时由 main 调用）
pub async fn run_admin_http(state: Arc<AppState>) -> std::io::Result<()> {
    let addr = format!("{}:{}", state.config.admin_http_host, state.config.admin_http_port);
    let listener = TcpListener::bind(&addr).await?;
    println!("Admin HTTP server running on http://{}{}", addr, state.config.admin_base_path);

    let fails = Arc::new(FailCounter::new());

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let state = Arc::clone(&state);
                let fails = Arc::clone(&fails);
                tokio::spawn(async move {
                    handle_admin_conn(stream, peer, state, fails).await;
                });
            }
            Err(e) => {
                eprintln!("Admin HTTP accept error: {}", e);
            }
        }
    }
}
