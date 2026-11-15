pub mod auth;
pub mod hub;
pub mod mailbox;
pub mod protocol;

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, WebSocketStream};

use auth::{new_challenge, verify_auth, AuthInfo, AuthRequest};
use hub::Hub;

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

async fn read_auth(
    ws: &mut WebSocketStream<TcpStream>,
    challenge: &str,
) -> Result<AuthInfo, String> {
    let message = tokio::time::timeout(AUTH_TIMEOUT, ws.next())
        .await
        .map_err(|_| "authentication timeout".to_string())?
        .ok_or_else(|| "connection closed during authentication".to_string())?
        .map_err(|err| format!("websocket error during authentication: {err}"))?;

    let text = match message {
        Message::Text(text) => text,
        _ => return Err("expected auth text message".to_string()),
    };
    let request: AuthRequest =
        serde_json::from_str(&text).map_err(|err| format!("invalid auth JSON: {err}"))?;
    verify_auth(&request, challenge)
}

fn handle_control(hub: &Hub, user: &str, text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = value.get("type")?.as_str()?;
    let request_id = value.get("requestId").cloned();
    let mut response = serde_json::json!({
        "type": kind,
        "requestId": request_id,
    });

    match kind {
        "lookup" => {
            response["type"] = serde_json::Value::String("pubkey".to_string());
            let target = value.get("userId")?.as_str()?;
            match hub.lookup_public_key(target) {
                Some(public_key) => {
                    response["userId"] = serde_json::Value::String(target.to_string());
                    response["publicKey"] = serde_json::Value::String(public_key);
                }
                None => {
                    response["type"] = serde_json::Value::String("pubkey-error".to_string());
                    response["message"] =
                        serde_json::Value::String("public key not found".to_string());
                }
            }
        }
        "service-register" => {
            let app_ids: Vec<String> = value
                .get("appIds")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            hub.set_services(user, app_ids);
            response["type"] = serde_json::Value::String("services-ok".to_string());
        }
        "service-lookup" => {
            let app_id = value.get("appId")?.as_str()?;
            response["type"] = serde_json::Value::String("services".to_string());
            response["appId"] = serde_json::Value::String(app_id.to_string());
            response["userIds"] = serde_json::Value::Array(
                hub.lookup_service(app_id)
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            );
        }
        _ => return None,
    }

    Some(response.to_string())
}

pub async fn handle_connection(stream: TcpStream, addr: SocketAddr, hub: Hub) {
    let Ok(mut ws) = accept_async(stream).await else {
        return;
    };

    let challenge = new_challenge();
    let challenge_message = serde_json::json!({
        "type": "challenge",
        "challenge": challenge,
    });
    if ws
        .send(Message::Text(challenge_message.to_string()))
        .await
        .is_err()
    {
        return;
    }

    let auth = match read_auth(&mut ws, &challenge).await {
        Ok(auth) => auth,
        Err(error) => {
            let _ = ws
                .send(Message::Text(
                    serde_json::json!({ "type": "auth-error", "message": error }).to_string(),
                ))
                .await;
            let _ = ws.close(None).await;
            return;
        }
    };

    if ws
        .send(Message::Text(
            serde_json::json!({ "type": "ready" }).to_string(),
        ))
        .await
        .is_err()
    {
        return;
    }

    let user = auth.user_id;
    hub.set_public_key(&user, &auth.public_key);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (text_tx, mut text_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let conn_id = hub.register(&user, tx);

    let (mut sink, mut source) = ws.split();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(bytes) = rx.recv() => {
                    if sink.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                Some(text) = text_rx.recv() => {
                    if sink.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                else => break,
            }
        }
    });

    while let Some(message) = source.next().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                let _ = hub.route(&user, &bytes);
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Text(text)) => {
                if let Some(response) = handle_control(&hub, &user, &text) {
                    let _ = text_tx.send(response);
                }
            }
            Ok(Message::Ping(_)) => {
                // tokio-tungstenite 自动回 pong
            }
            Ok(_) => {}
            Err(err) => {
                eprintln!("relay connection error from {addr}: {err}");
                break;
            }
        }
    }

    hub.unregister(&user, conn_id);
    writer.abort();
}

pub async fn run_server(listener: TcpListener, hub: Hub) {
    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let hub = hub.clone();
                tokio::spawn(async move {
                    handle_connection(stream, addr, hub).await;
                });
            }
            Err(err) => {
                eprintln!("accept failed: {err}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}
