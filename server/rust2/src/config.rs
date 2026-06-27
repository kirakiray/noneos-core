use serde::Deserialize;
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    #[arg(short, long, value_name = "FILE")]
    pub config: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,

    /// 监听的地址，设为 "" 表示监听所有接口
    #[serde(default = "default_host")]
    pub host: String,

    #[serde(default)]
    pub admin_user_id: Option<String>,

    // ── 超时 ──
    #[serde(default = "default_handshake_timeout")]
    pub handshake_timeout_secs: u64,

    // ── 消息大小限制 ──
    #[serde(default = "default_handshake_max_size")]
    pub handshake_max_size: usize,

    #[serde(default = "default_text_message_max_size")]
    pub text_message_max_size: usize,

    #[serde(default = "default_binary_payload_max_size")]
    pub binary_payload_max_size: usize,

    // ── 并发限制 ──
    /// 每 userId 最大并发 session 数
    #[serde(default = "default_max_sessions_per_user")]
    pub max_sessions_per_user: usize,

    /// 全局最大并发连接数（超出拒绝新的 TCP 连接）
    #[serde(default = "default_max_connections")]
    pub max_connections: usize,

    // ── 中继风暴防护 ──
    #[serde(default = "default_relay_fail_limit")]
    pub relay_fail_limit: u32,

    #[serde(default = "default_relay_fail_window_secs")]
    pub relay_fail_window_secs: u64,

    // ── 内存过载保护 ──
    #[serde(default = "default_max_memory_usage_percent")]
    pub max_memory_usage_percent: f64,

    // ── 转发流量额度 ──
    #[serde(default = "default_default_relay_quota_bytes")]
    pub default_relay_quota_bytes: u64,

    #[serde(default = "default_relay_small_message_max_bytes")]
    pub relay_small_message_max_bytes: u64,

    // ── 流量统计 ──
    #[serde(default)]
    pub traffic_db_path: Option<String>,

    /// 流量统计落盘间隔（秒），默认 30
    #[serde(default = "default_traffic_flush_interval")]
    pub traffic_flush_interval_secs: u64,

    #[serde(default = "default_traffic_minute_window")]
    pub traffic_minute_window: usize,
}

fn default_port() -> u16 { 8081 }
fn default_host() -> String { String::new() }
fn default_handshake_timeout() -> u64 { 10 }
fn default_handshake_max_size() -> usize { 1024 }
fn default_text_message_max_size() -> usize { 256 * 1024 }
fn default_binary_payload_max_size() -> usize { 256 * 1024 }
fn default_max_sessions_per_user() -> usize { 10 }
fn default_max_connections() -> usize { 500 }
fn default_relay_fail_limit() -> u32 { 10 }
fn default_relay_fail_window_secs() -> u64 { 60 }
fn default_max_memory_usage_percent() -> f64 { 95.0 }
fn default_default_relay_quota_bytes() -> u64 { 500 * 1024 * 1024 }
fn default_relay_small_message_max_bytes() -> u64 { 1024 }
fn default_traffic_flush_interval() -> u64 { 30 }
fn default_traffic_minute_window() -> usize { 60 }

impl Default for Config {
    fn default() -> Self {
        Self {
            port: default_port(),
            host: default_host(),
            admin_user_id: None,
            handshake_timeout_secs: default_handshake_timeout(),
            handshake_max_size: default_handshake_max_size(),
            text_message_max_size: default_text_message_max_size(),
            binary_payload_max_size: default_binary_payload_max_size(),
            max_sessions_per_user: default_max_sessions_per_user(),
            max_connections: default_max_connections(),
            relay_fail_limit: default_relay_fail_limit(),
            relay_fail_window_secs: default_relay_fail_window_secs(),
            max_memory_usage_percent: default_max_memory_usage_percent(),
            default_relay_quota_bytes: default_default_relay_quota_bytes(),
            relay_small_message_max_bytes: default_relay_small_message_max_bytes(),
            traffic_db_path: None,
            traffic_flush_interval_secs: default_traffic_flush_interval(),
            traffic_minute_window: default_traffic_minute_window(),
        }
    }
}
