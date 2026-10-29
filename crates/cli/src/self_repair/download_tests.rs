#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    thread,
};

fn server(responses: Vec<(String, Duration)>) -> (Url, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = Url::parse(&format!("http://{}/start", listener.local_addr().unwrap())).unwrap();
    let worker = thread::spawn(move || {
        for (response, delay) in responses {
            let start = Instant::now();
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(start.elapsed() < Duration::from_secs(3));
                thread::sleep(Duration::from_millis(2));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut reader = BufReader::new(&stream);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or_default() == 0 || line == "\r\n" {
                    break;
                }
            }
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (url, worker)
}

#[test]
fn urls_match_the_typescript_release_layout() {
    assert_eq!(
        release_url("", "1.2.3", "manifest.json").unwrap().as_str(),
        "https://github.com/lamtuanvu/pacer/releases/download/v1.2.3/manifest.json"
    );
    assert_eq!(
        release_url("http://127.0.0.1:9999/feed/", "1.2.3", "manifest.json")
            .unwrap()
            .as_str(),
        "http://127.0.0.1:9999/feed/1.2.3/manifest.json"
    );
}

#[test]
fn redirect_policy_allows_relative_and_signed_https_urls() {
    // GitHub asset redirects contain a signed query; the configured base cannot.
    validate(
        &Url::parse("https://release-assets.githubusercontent.com/asset?signature=test").unwrap(),
    )
    .unwrap();
    let (url, worker) = server(vec![
        ("HTTP/1.1 302 Found\r\nLocation: /asset\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), Duration::ZERO),
        ("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".into(), Duration::ZERO),
    ]);
    assert_eq!(
        fetch(url, 3, Instant::now() + Duration::from_secs(2)).unwrap(),
        b"abc"
    );
    worker.join().unwrap();
}

#[test]
fn size_and_deadline_limits_are_enforced_on_real_http_reads() {
    for (cap, delay, budget) in [
        (2, Duration::ZERO, Duration::from_secs(2)),
        (3, Duration::from_millis(200), Duration::from_millis(50)),
    ] {
        let (url, worker) = server(vec![(
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc".into(),
            delay,
        )]);
        assert!(fetch(url, cap, Instant::now() + budget).is_err());
        worker.join().unwrap();
    }
}

#[test]
fn redirects_cannot_escape_the_http_loopback_policy() {
    let (url, worker) = server(vec![("HTTP/1.1 302 Found\r\nLocation: http://example.invalid/asset\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(), Duration::ZERO)]);
    assert!(matches!(
        fetch(url, 3, Instant::now() + Duration::from_secs(2)),
        Err(RepairError::Invalid(_))
    ));
    worker.join().unwrap();
}
