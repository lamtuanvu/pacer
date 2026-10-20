//! Session WebSocket frame bridge.
use super::{auth::AuthKind, proxy};
use axum::{
    body::Body,
    extract::{
        FromRequestParts,
        ws::{Message, WebSocketUpgrade},
    },
    http::Request,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message as CoreMessage, client::IntoClientRequest};

pub async fn bridge(req: Request<Body>, target: (u16, String), auth: AuthKind) -> Response {
    let url = format!(
        "ws://127.0.0.1:{}{}",
        target.0,
        req.uri().path_and_query().map_or("/", |p| p.as_str())
    );
    let Ok(mut upstream) = url.into_client_request() else {
        return proxy::unavailable(false);
    };
    for (key, value) in req.headers() {
        if !matches!(
            key.as_str(),
            "host"
                | "connection"
                | "upgrade"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
        ) {
            upstream.headers_mut().insert(key.clone(), value.clone());
        }
    }
    if proxy::headers(upstream.headers_mut(), &target.1, auth).is_err() {
        return proxy::unavailable(false);
    }
    let (mut parts, _) = req.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let (core, _) = match tokio_tungstenite::connect_async(upstream).await {
        Ok(value) => value,
        Err(_) => return proxy::unavailable(false),
    };
    upgrade.on_upgrade(move |socket| async move {
        let (mut sink, mut source) = socket.split();
        let (mut core_sink, mut core_source) = core.split();
        let incoming = async {
            while let Some(Ok(message)) = source.next().await {
                let message = match message {
                    Message::Text(v) => CoreMessage::Text(v.to_string().into()),
                    Message::Binary(v) => CoreMessage::Binary(v),
                    Message::Ping(v) => CoreMessage::Ping(v),
                    Message::Pong(v) => CoreMessage::Pong(v),
                    Message::Close(v) => CoreMessage::Close(v.map(|v| {
                        tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: v.code.into(),
                            reason: v.reason.to_string().into(),
                        }
                    })),
                };
                if core_sink.send(message).await.is_err() {
                    break;
                }
            }
        };
        let outgoing = async {
            while let Some(Ok(message)) = core_source.next().await {
                let message = match message {
                    CoreMessage::Text(v) => Message::Text(v.to_string().into()),
                    CoreMessage::Binary(v) => Message::Binary(v),
                    CoreMessage::Ping(v) => Message::Ping(v),
                    CoreMessage::Pong(v) => Message::Pong(v),
                    CoreMessage::Close(v) => {
                        Message::Close(v.map(|v| axum::extract::ws::CloseFrame {
                            code: v.code.into(),
                            reason: v.reason.to_string().into(),
                        }))
                    }
                    CoreMessage::Frame(_) => continue,
                };
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! { _ = incoming => {}, _ = outgoing => {} }
    })
}
