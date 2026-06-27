use serde::Deserialize;
use clap::Parser;
use std::path::PathBuf;

/// 命令行参数结构体，使用 clap 库解析
/// 支持通过 -c 或 --config 指定配置文件路径
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// 配置文件路径（可选）
    /// 如果提供，服务器将尝试从该路径读取 TOML 配置
    #[arg(short, long, value_name = "FILE")]
    pub config: Option<PathBuf>,
}

/// 服务器配置结构体，对应 TOML 配置文件中的字段
/// 使用 serde 进行反序列化
#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    /// 服务器监听的端口号
    /// 如果配置文件中未指定，则使用 default_port() 返回的默认值 8081
    #[serde(default = "default_port")]
    pub port: u16,
    /// 服务器监听的 IP 地址或主机名
    /// 如果配置文件中未指定，则使用 default_host() 返回的默认值 "localhost"
    #[serde(default = "default_host")]
    pub host: String,
    /// 管理员用户的 userId，连接服务器后拥有管理权限
    /// 如果配置文件中未指定，则没有管理员
    #[serde(default)]
    pub admin_user_id: Option<String>,
    /// 握手超时时间（秒），客户端必须在此时间内完成 handshake_challenge
    /// 如果配置文件中未指定，默认为 5 秒
    #[serde(default = "default_handshake_timeout")]
    pub handshake_timeout_secs: u64,

    // ===== 消息大小限制（字节）=====
    /// 握手响应最大字节数（含 userId/sessionId/username/challenge/签名等）
    /// 正常字段远小于 1KB，默认 1024
    #[serde(default = "default_handshake_max_size")]
    pub handshake_max_size: usize,
    /// 文本消息（JSON 命令）最大字节数
    /// 默认 256KB
    #[serde(default = "default_text_message_max_size")]
    pub text_message_max_size: usize,
    /// 二进制 relay 帧负载最大字节数
    /// 默认 256KB
    #[serde(default = "default_binary_payload_max_size")]
    pub binary_payload_max_size: usize,

    // ===== 并发连接限制 =====
    /// 每个 userId 的最大并发 session 数
    /// 超出限制时新连接会被拒绝（不会踢掉旧 session）
    /// 默认 5
    #[serde(default = "default_max_sessions_per_user")]
    pub max_sessions_per_user: usize,

    // ===== 中继风暴防护 =====
    /// 单连接在窗口时间内允许 relay 到不存在 session 的最大失败次数
    /// 超出后该连接会被临时踢出，避免恶意客户端反复打不存在目标
    /// 默认 10 次
    #[serde(default = "default_relay_fail_limit")]
    pub relay_fail_limit: u32,
    /// relay 失败计数窗口时间（秒）
    /// 在该窗口内累计失败次数达到 relay_fail_limit 则踢出连接
    /// 默认 60 秒
    #[serde(default = "default_relay_fail_window_secs")]
    pub relay_fail_window_secs: u64,

    // ===== 内存过载保护 =====
    /// 最大内存使用率百分比，超过此值拒绝新的非管理员连接
    /// 管理员始终可以接入，确保紧急情况下仍可管理服务器
    /// 默认 95%
    #[serde(default = "default_max_memory_usage_percent")]
    pub max_memory_usage_percent: f64,

    // ===== 转发流量额度 =====
    /// 每个用户的默认转发流量额度（字节）
    /// 如果未指定，默认为 500MB
    #[serde(default = "default_default_relay_quota_bytes")]
    pub default_relay_quota_bytes: u64,
    /// 超额后仍允许转发的单条消息最大字节数
    /// 如果未指定，默认为 1KB
    #[serde(default = "default_relay_small_message_max_bytes")]
    pub relay_small_message_max_bytes: u64,

    // ===== 数据持久化 =====
    /// redb 数据库文件路径，用于持久化流量统计数据
    /// 只能通过配置文件指定，无默认值，必须配置
    pub redb_path: String,
    /// 流量统计数据落盘间隔（秒）
    /// 默认 30 秒
    #[serde(default = "default_traffic_flush_interval")]
    pub traffic_flush_interval_secs: u64,
}

/// 默认流量落盘间隔
fn default_traffic_flush_interval() -> u64 {
    30
}

/// 默认最大内存使用率
fn default_max_memory_usage_percent() -> f64 {
    95.0
}

/// 获取默认端口号的辅助函数
fn default_port() -> u16 {
    8081
}

/// 获取默认监听地址的辅助函数
fn default_host() -> String {
    "localhost".to_string()
}

/// 获取默认握手超时时间的辅助函数
fn default_handshake_timeout() -> u64 {
    5
}

/// 默认握手响应大小：1KB
fn default_handshake_max_size() -> usize {
    1024
}

/// 默认文本消息大小：256KB
fn default_text_message_max_size() -> usize {
    256 * 1024
}

/// 默认二进制 relay 负载大小：256KB
fn default_binary_payload_max_size() -> usize {
    256 * 1024
}

/// 默认每用户最大并发 session 数
fn default_max_sessions_per_user() -> usize {
    10
}

/// 默认 relay 失败次数上限
fn default_relay_fail_limit() -> u32 {
    10
}

/// 默认 relay 失败计数窗口（秒）
fn default_relay_fail_window_secs() -> u64 {
    60
}

/// 默认用户转发流量额度：500MB
fn default_default_relay_quota_bytes() -> u64 {
    500 * 1024 * 1024
}

/// 超额后仍允许转发的单条消息最大字节数：1KB
fn default_relay_small_message_max_bytes() -> u64 {
    1024
}

/// 为 Config 实现 Default trait，方便在未提供配置文件时创建默认配置实例
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
            relay_fail_limit: default_relay_fail_limit(),
            relay_fail_window_secs: default_relay_fail_window_secs(),
            max_memory_usage_percent: default_max_memory_usage_percent(),
            default_relay_quota_bytes: default_default_relay_quota_bytes(),
            relay_small_message_max_bytes: default_relay_small_message_max_bytes(),
            redb_path: "".to_string(),
            traffic_flush_interval_secs: default_traffic_flush_interval(),
        }
    }
}
