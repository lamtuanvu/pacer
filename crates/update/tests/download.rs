//! Transcribed from `test/update-replace.test.ts` (the download cases). The Rust
//! interface has no injectable `fetchFn` in its public `fetch_bytes`, so the redirect
//! cases use the crate's `fetch_bytes_with` transport injection (the Rust analogue of
//! the TypeScript `FetchFn`) and the loopback cases use a tiny real HTTP server.
use pacer_update::download::{
    Fetched, RELEASE_TIMEOUT, fetch_bytes, fetch_bytes_with, fetch_text, fetch_text_with,
};
use std::{
    cell::Cell,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};

fn deadline() -> Instant {
    Instant::now() + RELEASE_TIMEOUT
}

fn response(
    status: u16,
    location: Option<&str>,
    content_length: Option<&str>,
    body: &[u8],
) -> Fetched {
    Fetched {
        status,
        location: location.map(str::to_owned),
        content_length: content_length.map(str::to_owned),
        body: body.to_vec(),
    }
}

fn serve(respond: impl Fn(&str) -> (u16, String, String) + Send + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]);
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
            let (status, headers, body) = respond(&path);
            let reason = match status {
                200 => "OK",
                302 | 307 | 308 => "Found",
                404 => "Not Found",
                _ => "Status",
            };
            let message = format!(
                "HTTP/1.1 {status} {reason}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(message.as_bytes());
        }
    });
    format!("http://{addr}")
}

#[test]
fn download_limits_use_content_length_and_stop_streaming_after_the_byte_cap() {
    let declared = |_url: &str| Ok(response(200, None, Some("5"), b"12345"));
    let error = fetch_bytes_with(&declared, "fixture://declared", 4).unwrap_err();
    assert!(error.contains("exceeds 4 byte limit"), "{error}");

    let streaming = |_url: &str| Ok(response(200, None, None, b"12345"));
    let error = fetch_bytes_with(&streaming, "fixture://stream", 4).unwrap_err();
    assert!(error.contains("exceeds 4 byte limit"), "{error}");

    let metadata = |_url: &str| Ok(response(200, None, None, &vec![b'x'; 1024 * 1024 + 1]));
    let error = fetch_text_with(&metadata, "fixture://metadata").unwrap_err();
    assert!(error.contains("exceeds 1048576 byte limit"), "{error}");
}

#[test]
fn file_urls_report_a_missing_file_as_http_404() {
    // Rust reads file:// paths through `feed::read_file`, which surfaces ENOENT where
    // TypeScript's `releaseFetch` synthesises an HTTP 404. Both are download failures.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "hello").unwrap();
    let url = format!("file://{}", file.display());
    assert_eq!(fetch_text(&url, deadline()).unwrap(), "hello");

    let missing = format!("file://{}/missing", dir.path().display());
    let error = fetch_bytes(&missing, 100, deadline()).unwrap_err();
    assert!(error.contains("download failed:"), "{error}");
    assert!(
        error.contains("ENOENT") || error.contains("HTTP 404"),
        "{error}"
    );
}

#[test]
fn loopback_http_and_refused_connections() {
    let base = serve(|path| {
        if path == "/x.bin" {
            (200, String::new(), "\u{1}\u{2}\u{3}".into())
        } else {
            (404, String::new(), "no".into())
        }
    });
    assert_eq!(
        fetch_bytes(&format!("{base}/x.bin"), 100, deadline()).unwrap(),
        vec![1, 2, 3]
    );
    let error = fetch_bytes(&format!("{base}/nope"), 100, deadline()).unwrap_err();
    assert!(error.contains("(HTTP 404)"), "{error}");

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let dead_url = format!("{dead}/x");
    let error = fetch_bytes(&dead_url, 100, deadline()).unwrap_err();
    assert!(
        error.contains(&format!("download failed: {dead_url}")),
        "{error}"
    );
}

#[test]
fn redirects_are_refused_without_requesting_their_target_for_feeds() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let base = serve(move |path| {
        if path == "/start" {
            (
                302,
                "Location: http://example.com/x\r\n".into(),
                String::new(),
            )
        } else {
            counter.fetch_add(1, Ordering::SeqCst);
            (200, String::new(), "unexpected".into())
        }
    });
    let url = format!("{base}/start");
    let error = fetch_bytes(&url, 100, deadline()).unwrap_err();
    assert!(error.contains(&url), "{error}");
    assert!(error.contains("redirect"), "{error}");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[test]
fn https_redirects_across_hosts_and_relative_locations() {
    let seen: Cell<Vec<String>> = Cell::new(Vec::new());
    let fetch = |url: &str| {
        let mut visits = seen.take();
        visits.push(url.to_owned());
        seen.set(visits);
        Ok(match url {
            "https://github.com/start" => {
                response(302, Some("https://assets.example/path/file"), None, b"")
            }
            "https://assets.example/path/file" => {
                response(307, Some("../binary?token=1"), None, b"")
            }
            "https://assets.example/binary?token=1" => response(200, None, None, b"binary"),
            other => panic!("unexpected request: {other}"),
        })
    };
    assert_eq!(
        fetch_text_with(&fetch, "https://github.com/start").unwrap(),
        "binary"
    );
    assert_eq!(
        seen.take(),
        vec![
            "https://github.com/start".to_owned(),
            "https://assets.example/path/file".to_owned(),
            "https://assets.example/binary?token=1".to_owned(),
        ]
    );
}

#[test]
fn non_https_and_credentialed_redirects_are_refused() {
    for location in [
        "http://example.com/file",
        "file:///tmp/file",
        "ftp://example.com/file",
        "https://user:password@example.com/file",
    ] {
        let calls = Cell::new(0);
        let fetch = |_url: &str| {
            calls.set(calls.get() + 1);
            Ok(response(301, Some(location), None, b""))
        };
        let error = fetch_bytes_with(&fetch, "https://example.com/start", 100).unwrap_err();
        assert!(error.contains("redirect must target https://"), "{error}");
        assert_eq!(calls.get(), 1);
    }
}

#[test]
fn five_redirects_allowed_sixth_refused_missing_location_refused() {
    let calls = Cell::new(0);
    let fetch = |_url: &str| {
        calls.set(calls.get() + 1);
        if calls.get() <= 5 {
            Ok(response(308, Some("/next"), None, b""))
        } else {
            Ok(response(200, None, None, b"done"))
        }
    };
    assert_eq!(
        fetch_text_with(&fetch, "https://example.com/start").unwrap(),
        "done"
    );
    assert_eq!(calls.get(), 6);

    let calls = Cell::new(0);
    let looping = |_url: &str| {
        calls.set(calls.get() + 1);
        Ok(response(302, Some("/loop"), None, b""))
    };
    let error = fetch_text_with(&looping, "https://example.com/start").unwrap_err();
    assert!(error.contains("redirect limit (5) exceeded"), "{error}");
    assert_eq!(calls.get(), 6);

    let no_location = |_url: &str| Ok(response(302, None, None, b""));
    let error = fetch_text_with(&no_location, "https://example.com/start").unwrap_err();
    assert!(error.contains("has no Location"), "{error}");
}
