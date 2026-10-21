use super::*;
#[test]
fn rejects_unowned_windows_and_unknown_modes() {
    assert!(validate_request("main", "window").is_ok());
    assert!(validate_request("tray", "content").is_ok());
    assert!(validate_request("../../other", "window").is_err());
    assert!(validate_request("main", "screen").is_err());
}
#[test]
fn validates_bounded_png_geometry() {
    assert!(validate_image(&[1, 2, 3]).is_err());
    let good = include_bytes!("../../../../test/fixtures/live-control/one-pixel.png");
    assert!(validate_image(good).is_ok());
    let mut image = vec![0; 24];
    image[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    image[12..16].copy_from_slice(b"IHDR");
    image[16..20].copy_from_slice(&1u32.to_be_bytes());
    image[20..24].copy_from_slice(&1u32.to_be_bytes());
    assert!(validate_image(&image).is_err());
    image[16..20].copy_from_slice(&16385u32.to_be_bytes());
    assert!(validate_image(&image).is_err());
}

#[tokio::test]
async fn capture_claim_recovers_expired_worker_without_restarting_service_session() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for index in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(split) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..split]).to_lowercase();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let (status, body) = match index {
                0 => ("403 Forbidden", r#"{"error":{"code":"not_allowed"}}"#),
                1 => ("200 OK", r#"{"result":{"worker_token":"renewed"}}"#),
                _ => ("200 OK", r#"{"result":null}"#),
            };
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    let session = crate::client::Session::for_capture_test(
        reqwest::Client::builder().no_proxy().build().unwrap(),
        origin,
    );
    let mut token = "expired".to_owned();
    let result = claim_next(&session, "desktop", &mut token, Vec::new())
        .await
        .unwrap();
    assert!(result.is_null());
    assert_eq!(token, "renewed");
    let requests = server.join().unwrap();
    assert!(requests[1].starts_with("POST /v3/ops/desktop.capture.register "));
    assert!(requests[1].contains("expired"));
    assert!(requests[2].contains("renewed"));
}
