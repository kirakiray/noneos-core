use serde::Deserialize;
use clap::Parser;
use std::path::PathBuf;

/// 命令行参数结构体
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// 配置文件路径
    #[arg(short, long, value_name = "FILE")]
    pub config: Option<PathBuf>,
}

/// 服务器配置结构体
#[derive(Debug, Deserialize)]
pub struct Config {
    /// 监听端口，默认为 8081
    #[serde(default = "default_port")]
    pub port: u16,
    /// 监听地址，默认为 127.0.0.1
    #[serde(default = "default_host")]
    pub host: String,
}

/// 获取默认端口
fn default_port() -> u16 {
    8081
}

/// 获取默认监听地址
fn default_host() -> String {
    "127.0.0.1".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: default_port(),
            host: default_host(),
        }
    }
}
