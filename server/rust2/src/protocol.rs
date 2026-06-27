use serde::{Serialize, Deserialize};

/// 挑战信息
#[derive(Serialize, Deserialize)]
pub struct HandshakeChallenge {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub challenge: String,
}

/// 握手响应
#[derive(Serialize)]
pub struct HandshakeResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_admin: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// relay 帧 header（文本 relay 内嵌）
#[derive(Deserialize)]
pub struct BinaryRelayHeader {
    #[serde(rename = "type")]
    pub msg_type: Option<String>,
    pub action: Option<String>,
    pub target_user_id: Option<String>,
    pub target_session_id: Option<String>,
}

/// 管理命令请求
#[derive(Deserialize)]
pub struct AdminCommand {
    pub action: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_ids: Option<Vec<String>>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub page_size: u32,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub quota_bytes: Option<u64>,
}

/// 管理命令响应
#[derive(Default, Serialize)]
pub struct AdminResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_inbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_outbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_relay_forwarded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_handshake_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_stats: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quotas: Option<Vec<serde_json::Value>>,
}

/// 获取当前毫秒时间戳
#[inline]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 计算消息字节大小
pub fn msg_byte_size(msg: &tungstenite::Message) -> usize {
    match msg {
        tungstenite::Message::Text(s) => s.len(),
        tungstenite::Message::Binary(d) => d.len(),
        tungstenite::Message::Ping(d) | tungstenite::Message::Pong(d) => d.len(),
        tungstenite::Message::Close(_) => 4,
        tungstenite::Message::Frame(_) => 0,
    }
}
