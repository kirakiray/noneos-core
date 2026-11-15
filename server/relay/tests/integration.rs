use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use noneos_relay::auth::user_id_for_public_key;
use noneos_relay::hub::{Hub, HubConfig};
use noneos_relay::protocol::encode_mux_frame;
use noneos_relay::run_server;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::EncodePublicKey;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Identity {
    signing: SigningKey,
    public_key: String,
    user_id: String,
}

fn identity() -> Identity {
    let signing = SigningKey::random(&mut rand::rngs::OsRng);
    let der = signing.verifying_key().to_public_key_der().unwrap();
    let public_key = general_purpose::STANDARD.encode(der.as_bytes());
    let user_id = user_id_for_public_key(&public_key);
    Identity {
        signing,
        public_key,
        user_id,
    }
}

async fn start_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hub = Hub::new(HubConfig::default());
    let task = tokio::spawn(async move {
        run_server(listener, hub).await;
    });
    (format!("ws://{addr}"), task)
}

async fn receive_text(ws: &mut Ws) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("timeout waiting for text")
        .expect("stream ended")
        .expect("websocket error");
    match message {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected text frame, got {other:?}"),
    }
}

async fn connect(base: &str, identity: &Identity) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{base}/"))
        .await
        .unwrap();
    let challenge = receive_text(&mut ws).await;
    assert_eq!(challenge["type"], "challenge");
    let challenge = challenge["challenge"].as_str().unwrap();
    let signature: Signature = identity.signing.sign(challenge.as_bytes());
    ws.send(Message::Text(
        serde_json::json!({
            "type": "auth",
            "userId": identity.user_id,
            "publicKey": identity.public_key,
            "signature": general_purpose::STANDARD.encode(signature.to_bytes()),
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let ready = receive_text(&mut ws).await;
    assert_eq!(ready["type"], "ready");
    ws
}

async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    let message = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("timeout waiting for message")
        .expect("stream ended")
        .expect("websocket error");
    match message {
        Message::Binary(bytes) => bytes,
        other => panic!("expected binary frame, got {other:?}"),
    }
}

#[tokio::test]
async fn relays_between_authenticated_users() {
    let (base, server) = start_server().await;
    let alice = identity();
    let bob = identity();
    let mut bob_ws = connect(&base, &bob).await;
    let mut alice_ws = connect(&base, &alice).await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    let frame = encode_mux_frame(&alice.user_id, &bob.user_id, &[1, 2, 3]);
    alice_ws.send(Message::Binary(frame.clone())).await.unwrap();
    assert_eq!(next_binary(&mut bob_ws).await, frame);

    server.abort();
}

#[tokio::test]
async fn queues_then_flushes_offline_messages() {
    let (base, server) = start_server().await;
    let alice = identity();
    let bob = identity();
    let mut alice_ws = connect(&base, &alice).await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    let frame = encode_mux_frame(&alice.user_id, &bob.user_id, &[7, 8]);
    alice_ws.send(Message::Binary(frame.clone())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    let mut bob_ws = connect(&base, &bob).await;
    assert_eq!(next_binary(&mut bob_ws).await, frame);

    server.abort();
}

#[tokio::test]
async fn looks_up_public_key_after_auth() {
    let (base, server) = start_server().await;
    let alice = identity();
    let bob = identity();
    let mut alice_ws = connect(&base, &alice).await;
    let _bob_ws = connect(&base, &bob).await;

    alice_ws
        .send(Message::Text(
            serde_json::json!({
                "type": "lookup",
                "requestId": "r1",
                "userId": bob.user_id,
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let response = receive_text(&mut alice_ws).await;
    assert_eq!(response["type"], "pubkey");
    assert_eq!(response["requestId"], "r1");
    assert_eq!(response["publicKey"], bob.public_key);

    server.abort();
}

#[tokio::test]
async fn registers_and_looks_up_services() {
    let (base, server) = start_server().await;
    let alice = identity();
    let bob = identity();
    let mut alice_ws = connect(&base, &alice).await;
    let mut bob_ws = connect(&base, &bob).await;

    alice_ws
        .send(Message::Text(
            serde_json::json!({
                "type": "service-register",
                "requestId": "s1",
                "appIds": ["chat-v1"],
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(receive_text(&mut alice_ws).await["type"], "services-ok");

    bob_ws
        .send(Message::Text(
            serde_json::json!({
                "type": "service-lookup",
                "requestId": "s2",
                "appId": "chat-v1",
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let response = receive_text(&mut bob_ws).await;
    assert_eq!(response["type"], "services");
    let users = response["userIds"].as_array().unwrap();
    assert!(users.iter().any(|id| id == &alice.user_id));

    server.abort();
}

#[tokio::test]
async fn rejects_bad_signature() {
    let (base, server) = start_server().await;
    let alice = identity();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{base}/"))
        .await
        .unwrap();
    let challenge = receive_text(&mut ws).await;
    assert_eq!(challenge["type"], "challenge");
    ws.send(Message::Text(
        serde_json::json!({
            "type": "auth",
            "userId": alice.user_id,
            "publicKey": alice.public_key,
            "signature": general_purpose::STANDARD.encode([0u8; 64]),
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let response = receive_text(&mut ws).await;
    assert_eq!(response["type"], "auth-error");
    server.abort();
}
