use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use noneos_relay::hub::{Hub, HubConfig};
use noneos_relay::mailbox::{FileMailbox, MailboxStore, MemoryMailbox};
use noneos_relay::run_server;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut port = 8081u16;
    let mut mailbox_path: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" | "-p" => {
                port = args.next().unwrap_or_else(|| "8081".into()).parse()?;
            }
            "--mailbox" => {
                mailbox_path = args.next();
            }
            "--help" | "-h" => {
                println!("Usage: noneos-relay [--port 8081] [--mailbox <file>]");
                return Ok(());
            }
            other => {
                return Err(format!("unknown argument: {other}").into());
            }
        }
    }

    let mailbox: Arc<dyn MailboxStore> = match mailbox_path {
        Some(path) => Arc::new(FileMailbox::open(path)?),
        None => Arc::new(MemoryMailbox::default()),
    };

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await?;
    println!("noneos-relay listening on ws://{addr} (ECDSA challenge-response)");
    run_server(
        listener,
        Hub::with_mailbox(
            HubConfig {
                mailbox_max_per_user: 100,
                mailbox_ttl: Duration::from_secs(3600),
            },
            mailbox,
        ),
    )
    .await;
    Ok(())
}
