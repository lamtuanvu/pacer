//! Transcribed from `test/update-replace.test.ts` (download half) with a scripted
//! [`Transport`] standing in for the TypeScript injectable `FetchFn`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_update::download::{
    FetchResponse, Transport, fetch_bytes, fetch_bytes_with, fetch_text, fetch_text_with,
};
use std::{
    cell::RefCell,
    io::{BufRead, BufReader, Cursor, Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn response(status: u16, location: Option<&str>, length: Option<u64>, body: &str) -> FetchResponse {
    FetchResponse {
        status,
        location: location.map(str::to_owned),
        content_length: length,
        body: Box::new(Cursor::new(body.as_bytes().to_vec())),
    }
}

/// One scripted response per URL, with the requested URLs recorded like the TS `seen`.
struct Scripted<F> {
    fetch: F,
    seen: RefCell<Vec<String>>,
}

impl<F> Scripted<F> {
    fn new(fetch: F) -> Self {
        Self {
            fetch,
            seen: RefCell::new(Vec::new()),
        }
    }
    fn seen(&self) -> Vec<String> {
        self.seen.borrow().clone()
    }
}

impl<F> Transport for Scripted<F>
where
    F: Fn(&str) -> Result<FetchResponse, String>,
{
    fn fetch(&self, url: &str, _deadline: Instant) -> Result<FetchResponse, String> {
        self.seen.borrow_mut().push(url.to_owned());
        (self.fetch)(url)
    }
}

/// A `Read` that reports one small chunk per call, so we can prove the reader stops
/// at the cap instead of draining the whole stream.
struct Chunks {
    remaining: usize,
    pulls: std::sync::Arc<AtomicUsize>,
}

impl Read for Chunks {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.pulls.fetch_add(1, Ordering::SeqCst);
        if self.remaining == 0 || buf.is_empty() {
            return Ok(0);
        }
        let n = buf.len().min(3).min(self.remaining);
        self.remaining -= n;
        for slot in buf.iter_mut().take(n) {
            *slot = b'x';
        }
        Ok(n)
    }
}

/// Serve one raw HTTP response on loopback, like `crates/cli`'s download tests.
fn serve_once(raw: &str) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/start", listener.local_addr().unwrap());
    let raw = raw.to_owned();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(&stream);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or_default() == 0 || line == "\r\n" {
                break;
            }
        }
        let _ = stream.write_all(raw.as_bytes());
    });
    (url, worker)
}

#[test]
fn download_limits_use_content_length_and_stop_streaming_after_the_byte_cap() {
    let declared = Scripted::new(|_: &str| Ok(response(200, None, Some(5), "12345")));
    let err = fetch_bytes_with(&declared, "fixture://declared", 4, deadline()).unwrap_err();
    assert!(err.contains("exceeds 4 byte limit"), "{err}");

    let pulls = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = pulls.clone();
    let streaming = Scripted::new(move |_: &str| {
        Ok(FetchResponse {
            status: 200,
            location: None,
            content_length: None,
            body: Box::new(Chunks {
                remaining: 64,
                pulls: counted.clone(),
            }),
        })
    });
    let err = fetch_bytes_with(&streaming, "fixture://stream", 4, deadline()).unwrap_err();
    assert!(err.contains("exceeds 4 byte limit"), "{err}");
    assert!(pulls.load(Ordering::SeqCst) <= 3);

    let metadata =
        Scripted::new(|_: &str| Ok(response(200, None, None, &"x".repeat(1024 * 1024 + 1))));
    let err = fetch_text_with(&metadata, "fixture://metadata", deadline()).unwrap_err();
    assert!(err.contains("exceeds 1048576 byte limit"), "{err}");
}

#[test]
fn file_urls_report_a_missing_file_as_http_404() {
    let dir = tempfile::tempdir().unwrap();
    let present = dir.path().join("a.txt");
    std::fs::write(&present, "hello").unwrap();
    let url = format!("file://{}", present.display());
    assert_eq!(fetch_text(&url, deadline()).unwrap(), "hello");

    // Rust's `feed::read_file` keeps Node's ENOENT wording; the TS `releaseFetch`
    // returned HTTP 404, but both are the same "missing file" download failure.
    let missing = format!("file://{}", dir.path().join("missing").display());
    let err = fetch_bytes(&missing, 1024, deadline()).unwrap_err();
    assert!(
        err.starts_with(&format!("download failed: {missing} (")),
        "{err}"
    );
    assert!(err.contains("ENOENT"), "{err}");
}

#[test]
fn loopback_http_and_refused_connections() {
    let (url, worker) =
        serve_once("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n\x01\x02\x03");
    assert_eq!(fetch_bytes(&url, 1024, deadline()).unwrap(), vec![1, 2, 3]);
    worker.join().unwrap();

    let (not_found, worker) =
        serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let err = fetch_bytes(&not_found, 1024, deadline()).unwrap_err();
    assert!(err.contains("(HTTP 404)"), "{err}");
    worker.join().unwrap();

    let dead = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!("http://{}/x", dead.local_addr().unwrap());
    drop(dead);
    let err = fetch_bytes(&dead_url, 1024, deadline()).unwrap_err();
    assert!(
        err.starts_with(&format!("download failed: {dead_url} (")),
        "{err}"
    );
}

#[test]
fn redirects_are_refused_without_requesting_their_target_for_feeds() {
    let (url, worker) = serve_once(
        "HTTP/1.1 302 Found\r\nLocation: http://example.com/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    let err = fetch_bytes(&url, 1024, deadline()).unwrap_err();
    assert!(err.contains(&url), "{err}");
    assert!(err.contains("redirect"), "{err}");
    // Only the local server was contacted: the refused target was never requested.
    worker.join().unwrap();
}

#[test]
fn https_redirects_across_hosts_and_relative_locations() {
    let script = Scripted::new(|url: &str| match url {
        "https://github.com/start" => Ok(response(
            302,
            Some("https://assets.example/path/file"),
            None,
            "",
        )),
        "https://assets.example/path/file" => {
            Ok(response(307, Some("../binary?token=1"), None, ""))
        }
        _ => Ok(response(200, None, None, "binary")),
    });
    assert_eq!(
        fetch_text_with(&script, "https://github.com/start", deadline()).unwrap(),
        "binary"
    );
    assert_eq!(
        script.seen(),
        [
            "https://github.com/start",
            "https://assets.example/path/file",
            "https://assets.example/binary?token=1"
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
        let script = Scripted::new(move |_: &str| Ok(response(301, Some(location), None, "")));
        let err =
            fetch_bytes_with(&script, "https://example.com/start", 1024, deadline()).unwrap_err();
        assert!(err.contains("redirect must target https://"), "{err}");
        assert_eq!(script.seen().len(), 1);
    }
}

#[test]
fn five_redirects_allowed_sixth_refused_missing_location_refused() {
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let script = Scripted::new(move |_: &str| {
        let n = counted.fetch_add(1, Ordering::SeqCst) + 1;
        if n <= 5 {
            Ok(response(308, Some("/next"), None, ""))
        } else {
            Ok(response(200, None, None, "done"))
        }
    });
    assert_eq!(
        fetch_text_with(&script, "https://example.com/start", deadline()).unwrap(),
        "done"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 6);

    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let looped = Scripted::new(move |_: &str| {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok(response(302, Some("/loop"), None, ""))
    });
    let err = fetch_text_with(&looped, "https://example.com/start", deadline()).unwrap_err();
    assert!(err.contains("redirect limit (5) exceeded"), "{err}");
    assert_eq!(calls.load(Ordering::SeqCst), 6);

    let missing = Scripted::new(|_: &str| Ok(response(302, None, None, "")));
    let err = fetch_text_with(&missing, "https://example.com/start", deadline()).unwrap_err();
    assert!(err.contains("has no Location"), "{err}");
}
