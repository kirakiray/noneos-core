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
#[derive(Debug, Deserialize)]
pub struct Config {
    /// 服务器监听的端口号
    /// 如果配置文件中未指定，则使用 default_port() 返回的默认值 8081
    #[serde(default = "default_port")]
    pub port: u16,
    /// 服务器监听的 IP 地址或主机名
    /// 如果配置文件中未指定，则使用 default_host() 返回的默认值 "127.0.0.1"
    #[serde(default = "default_host")]
    pub host: String,
    /// 管理员用户的 userId，连接服务器后拥有管理权限
    /// 如果配置文件中未指定，则没有管理员
    #[serde(default)]
    pub admin_user_id: Option<String>,
}

/// 获取默认端口号的辅助函数
fn default_port() -> u16 {
    8081
}

/// 获取默认监听地址的辅助函数
fn default_host() -> String {
    "127.0.0.1".to_string()
}

/// 为 Config 实现 Default trait，方便在未提供配置文件时创建默认配置实例
impl Default for Config {
    fn default() -> Self {
        Self {
            port: default_port(),
            host: default_host(),
            admin_user_id: None,
        }
    }
}
