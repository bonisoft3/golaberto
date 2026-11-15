use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    io::{self, BufRead, Write},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use wreq::{
    Client,
    header::{
        ACCEPT, ACCEPT_LANGUAGE, HeaderMap, HeaderValue, IF_MODIFIED_SINCE, IF_NONE_MATCH,
        LOCATION, REFERER, USER_AGENT,
    },
    redirect,
};
use wreq_util::{Emulation, Platform, Profile};

const TIMEOUT: Duration = Duration::from_secs(15);
const LIMIT: usize = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const BASE: &str = "https://www.sofascore.com/api/v1/";
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(default)]
    id: Value,
    path: String,
    etag: Option<String>,
    last_modified: Option<String>,
    max_requests: Option<u32>,
}
#[derive(Serialize)]
struct Hop {
    status: u16,
    url: String,
}
#[derive(Serialize)]
struct Output {
    id: Value,
    status: Option<u16>,
    headers: BTreeMap<String, String>,
    body: String,
    final_url: Option<String>,
    redirects: Vec<Hop>,
    requests: u32,
    elapsed_ms: u128,
    error: Option<String>,
}
impl Output {
    fn new(id: Value) -> Self {
        Self {
            id,
            status: None,
            headers: BTreeMap::new(),
            body: String::new(),
            final_url: None,
            redirects: Vec::new(),
            requests: 0,
            elapsed_ms: 0,
            error: None,
        }
    }
}
fn validate_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "invalid API URL".to_string())?;
    if u.scheme() != "https"
        || !matches!(
            u.host_str(),
            Some("www.sofascore.com" | "sofascore.com" | "api.sofascore.com")
        )
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || !u.path().starts_with("/api/v1/")
        || u.fragment().is_some()
    {
        return Err("URL outside allowed SofaScore API".into());
    }
    Ok(u)
}
fn path_url(path: &str) -> Result<url::Url, String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains('#')
        || path.chars().any(|c| c.is_control())
    {
        return Err("invalid API path".into());
    }
    let u = url::Url::parse(BASE)
        .unwrap()
        .join(path)
        .map_err(|_| "invalid API path".to_string())?;
    if u.host_str() != Some("www.sofascore.com") {
        return Err("invalid API path".into());
    }
    validate_url(u.as_str())
}
fn client() -> Result<Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.sofascore.com/"),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers.insert(
        "x-requested-with",
        HeaderValue::from_static("XMLHttpRequest"),
    );
    Client::builder()
        .emulation(
            Emulation::builder()
                .profile(Profile::Chrome149)
                .platform(Platform::MacOS)
                .headers(false)
                .build(),
        )
        .default_headers(headers)
        .timeout(TIMEOUT)
        .redirect(redirect::Policy::none())
        .retry(wreq::retry::Policy::never())
        .build()
        .map_err(|e| format!("create HTTP client: {e}"))
}
async fn request(
    client: &Client,
    mut url: url::Url,
    input: &Input,
    out: &mut Output,
    redirect_valid: fn(&str) -> Result<url::Url, String>,
) -> Result<(), String> {
    let etag = input
        .etag
        .as_deref()
        .map(HeaderValue::from_str)
        .transpose()
        .map_err(|_| "invalid etag header".to_string())?;
    let modified = input
        .last_modified
        .as_deref()
        .map(HeaderValue::from_str)
        .transpose()
        .map_err(|_| "invalid last_modified header".to_string())?;
    let budget = input.max_requests.unwrap_or(10);
    loop {
        if out.requests >= budget {
            return Err("request budget exhausted".into());
        }
        out.requests += 1;
        out.final_url = Some(url.to_string());
        let mut req = client.get(url.as_str());
        if let Some(h) = &etag {
            req = req.header(IF_NONE_MATCH, h.clone());
        }
        if let Some(h) = &modified {
            req = req.header(IF_MODIFIED_SINCE, h.clone());
        }
        let response = req
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = response.status();
        out.status = Some(status.as_u16());
        out.headers.clear();
        for (name, value) in response.headers() {
            let value = value
                .to_str()
                .map_err(|_| format!("invalid response header: {name}"))?;
            out.headers
                .entry(name.as_str().to_owned())
                .and_modify(|v| {
                    v.push_str(", ");
                    v.push_str(value);
                })
                .or_insert_with(|| value.to_owned());
        }
        if status.is_redirection() && status.as_u16() != 304 {
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or("redirect without location")?
                .to_str()
                .map_err(|_| "invalid redirect location")?;
            let target = url
                .join(location)
                .map_err(|_| "invalid redirect location")?;
            if out.redirects.len() == MAX_REDIRECTS {
                return Err(format!("more than {MAX_REDIRECTS} redirects"));
            }
            url = redirect_valid(target.as_str())?;
            out.redirects.push(Hop {
                status: status.as_u16(),
                url: url.to_string(),
            });
            continue;
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read response: {e}"))?;
            if chunk.len() > LIMIT - body.len() {
                return Err("response exceeds 8 MiB".into());
            }
            body.extend_from_slice(&chunk);
        }
        out.body = String::from_utf8(body).map_err(|_| "response body is not UTF-8".to_string())?;
        return Ok(());
    }
}
async fn execute(
    client: &Client,
    input: Input,
    url: Result<url::Url, String>,
    valid: fn(&str) -> Result<url::Url, String>,
    timeout: Duration,
) -> Output {
    let start = Instant::now();
    let mut out = Output::new(input.id.clone());
    let result = match url {
        Ok(url) => {
            match tokio::time::timeout(timeout, request(client, url, &input, &mut out, valid)).await
            {
                Ok(result) => result,
                Err(_) => Err("request timed out".into()),
            }
        }
        Err(e) => Err(e),
    };
    out.error = result.err();
    out.elapsed_ms = start.elapsed().as_millis();
    out
}
const HEAD_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 64 * 1024;

fn reply(status: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

fn refusal(status: &str, message: &str) -> Vec<u8> {
    reply(status, serde_json::json!({"error": message}).to_string().as_bytes())
}

// One request per connection: the bridge's caller is Airlock's daprd, which
// sends one POST /fetch per effect run and reads the answer whole.
async fn answer(client: &Client, stream: &mut TcpStream) -> Vec<u8> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= HEAD_LIMIT {
            return refusal("431 Request Header Fields Too Large", "request head exceeds 16 KiB");
        }
        match stream.read(&mut byte).await {
            Ok(1) => head.push(byte[0]),
            _ => return refusal("400 Bad Request", "incomplete request head"),
        }
    }
    let Ok(head) = std::str::from_utf8(&head) else {
        return refusal("400 Bad Request", "request head is not UTF-8");
    };
    let mut lines = head.split("\r\n");
    let mut line = lines.next().unwrap_or("").split(' ');
    let (method, target) = (line.next().unwrap_or(""), line.next().unwrap_or(""));
    let path = target.split('?').next().unwrap_or("");
    if path == "/healthz" && method == "GET" {
        return reply("200 OK", b"{}");
    }
    if path != "/fetch" {
        return refusal("404 Not Found", "unknown path");
    }
    if method != "POST" {
        return refusal("405 Method Not Allowed", "only POST /fetch");
    }
    let mut length = None;
    for header in lines {
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let Some(length) = length else {
        return refusal("411 Length Required", "content-length is required");
    };
    if length > BODY_LIMIT {
        return refusal("413 Content Too Large", "request body exceeds 64 KiB");
    }
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).await.is_err() {
        return refusal("400 Bad Request", "incomplete request body");
    }
    let out = match serde_json::from_slice::<Input>(&body) {
        Ok(input) => {
            let url = path_url(&input.path);
            execute(client, input, url, validate_url, TIMEOUT).await
        }
        Err(e) => {
            let mut out = Output::new(Value::Null);
            out.error = Some(format!("invalid request: {e}"));
            out
        }
    };
    reply("200 OK", &serde_json::to_vec(&out).unwrap_or_default())
}

async fn serve(address: &str) -> Result<(), String> {
    let client = client()?;
    let listener = TcpListener::bind(address)
        .await
        .map_err(|e| format!("listen on {address}: {e}"))?;
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let response = answer(&client, &mut stream).await;
        let _ = stream.write_all(&response).await;
        let _ = stream.shutdown().await;
    }
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().skip(1).collect();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    if args.len() == 2 && args[0] == "--listen" {
        return runtime.block_on(serve(&args[1]));
    }
    let client = client()?;
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    if args.len() == 1 {
        let input = Input {
            id: Value::Null,
            path: String::new(),
            etag: None,
            last_modified: None,
            max_requests: None,
        };
        let out = runtime.block_on(execute(
            &client,
            input,
            validate_url(&args[0]),
            validate_url,
            TIMEOUT,
        ));
        if let Some(e) = out.error {
            return Err(e);
        }
        if !matches!(out.status, Some(200..=299)) {
            return Err(format!("HTTP {}: {}", out.status.unwrap_or(0), out.body));
        }
        stdout
            .write_all(out.body.as_bytes())
            .map_err(|e| e.to_string())?;
    } else if args.is_empty() {
        for line in io::stdin().lock().lines() {
            let line = line.map_err(|e| e.to_string())?;
            let parsed: Result<Input, _> = serde_json::from_str(&line);
            let out = match parsed {
                Ok(input) => {
                    let url = path_url(&input.path);
                    runtime.block_on(execute(&client, input, url, validate_url, TIMEOUT))
                }
                Err(e) => {
                    let id = serde_json::from_str::<Value>(&line)
                        .ok()
                        .and_then(|v| v.get("id").cloned())
                        .unwrap_or(Value::Null);
                    let mut out = Output::new(id);
                    out.error = Some(format!("invalid request: {e}"));
                    out
                }
            };
            serde_json::to_writer(&mut stdout, &out).map_err(|e| e.to_string())?;
            stdout
                .write_all(b"\n")
                .and_then(|_| stdout.flush())
                .map_err(|e| e.to_string())?;
        }
    } else {
        return Err("usage: sofascore_fetch [--listen ADDRESS | https://www.sofascore.com/api/v1/...]".into());
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    fn local(raw: &str) -> Result<url::Url, String> {
        let u = url::Url::parse(raw).map_err(|e| e.to_string())?;
        if u.scheme() != "http"
            || u.host_str() != Some("127.0.0.1")
            || !u.path().starts_with("/api/v1/")
        {
            return Err("invalid redirect".into());
        }
        Ok(u)
    }
    fn serve(responses: Vec<Vec<u8>>) -> (url::Url, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = url::Url::parse(&format!(
            "http://{}/api/v1/test",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = Vec::new();
                    let mut byte = [0];
                    while !request.ends_with(b"\r\n\r\n") {
                        stream.read_exact(&mut byte).unwrap();
                        request.push(byte[0]);
                    }
                    let _ = stream.write_all(&response);
                    String::from_utf8(request).unwrap().to_ascii_lowercase()
                })
                .collect()
        });
        (url, handle)
    }
    fn input() -> Input {
        Input {
            id: serde_json::json!(1),
            path: "test".into(),
            etag: None,
            last_modified: None,
            max_requests: None,
        }
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    #[test]
    fn path_and_header_validation() {
        for p in [
            "https://evil.test/api/v1/test",
            "//evil.test/a",
            "../other",
            "/api/v1/test",
            "x\r\ny",
            "x#frag",
            "\\evil",
        ] {
            assert!(path_url(p).is_err(), "{p}");
        }
        assert!(path_url("event/12?x=1").is_ok());
        for u in [
            "https://evil.test/api/v1/a",
            "https://www.sofascore.com:444/api/v1/a",
            "https://www.sofascore.com/login",
            "https://u@www.sofascore.com/api/v1/a",
        ] {
            assert!(validate_url(u).is_err());
        }
        let mut i = input();
        i.etag = Some("bad\r\nheader: value".into());
        let out = runtime().block_on(execute(
            &client().unwrap(),
            i,
            path_url("test"),
            validate_url,
            TIMEOUT,
        ));
        assert_eq!(out.requests, 0);
        assert!(out.error.unwrap().contains("etag"));
    }
    #[test]
    fn conditionals_304_and_raw_error_body() {
        let (url, server) = serve(vec![b"HTTP/1.1 304 Not Modified\r\nETag: \"abc\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Length: 6\r\nConnection: close\r\n\r\n{broken".to_vec()]);
        let rt = runtime();
        let c = client().unwrap();
        let mut i = input();
        i.etag = Some("\"abc\"".into());
        i.last_modified = Some("Wed, 21 Oct 2015 07:28:00 GMT".into());
        let first = rt.block_on(execute(&c, i, Ok(url.clone()), local, TIMEOUT));
        assert_eq!(first.status, Some(304));
        assert_eq!(first.headers["etag"], "\"abc\"");
        assert!(first.error.is_none());
        let second = rt.block_on(execute(&c, input(), Ok(url), local, TIMEOUT));
        assert_eq!(second.status, Some(429));
        assert_eq!(second.body, "{broke");
        assert_eq!(second.headers["retry-after"], "30");
        assert!(second.error.is_none());
        let requests = server.join().unwrap();
        assert!(requests[0].contains("if-none-match: \"abc\"\r\n"));
        assert!(requests[0].contains("if-modified-since: wed, 21 oct 2015 07:28:00 gmt\r\n"));
    }
    #[test]
    fn redirects_obey_budget_and_scope() {
        let redirect = b"HTTP/1.1 302 Found\r\nLocation: /api/v1/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (url, server) = serve(vec![redirect.clone()]);
        let mut i = input();
        i.max_requests = Some(1);
        let out = runtime().block_on(execute(&client().unwrap(), i, Ok(url), local, TIMEOUT));
        assert_eq!(out.requests, 1);
        assert_eq!(out.error.as_deref(), Some("request budget exhausted"));
        server.join().unwrap();
        let (url, server) = serve(vec![
            redirect,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec(),
        ]);
        let out = runtime().block_on(execute(
            &client().unwrap(),
            input(),
            Ok(url),
            local,
            TIMEOUT,
        ));
        assert_eq!(out.requests, 2);
        assert_eq!(out.body, "ok");
        assert_eq!(out.redirects.len(), 1);
        assert_eq!(out.redirects[0].status, 302);
        assert!(out.redirects[0].url.ends_with("/api/v1/next"));
        server.join().unwrap();
        let (url, server) = serve(vec![b"HTTP/1.1 302 Found\r\nLocation: https://evil.test/api/v1/a\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]);
        let out = runtime().block_on(execute(
            &client().unwrap(),
            input(),
            Ok(url),
            local,
            TIMEOUT,
        ));
        assert_eq!(out.requests, 1);
        assert_eq!(out.error.as_deref(), Some("invalid redirect"));
        assert!(out.redirects.is_empty());
        server.join().unwrap();
    }
    // A provider that loops redirects must not spend the source's budget
    // without bound: the sixth redirect is refused after five were followed.
    #[test]
    fn redirects_stop_after_five_hops() {
        let redirect = b"HTTP/1.1 301 Moved Permanently\r\nLocation: /api/v1/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (url, server) = serve(vec![redirect; MAX_REDIRECTS + 1]);
        let out = runtime().block_on(execute(&client().unwrap(), input(), Ok(url), local, TIMEOUT));
        assert_eq!(out.requests as usize, MAX_REDIRECTS + 1);
        assert_eq!(out.redirects.len(), MAX_REDIRECTS);
        assert_eq!(out.error.as_deref(), Some("more than 5 redirects"));
        server.join().unwrap();
    }
    #[test]
    fn body_size_is_bounded() {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            LIMIT + 1
        )
        .into_bytes();
        response.extend(vec![b'x'; LIMIT + 1]);
        let (url, server) = serve(vec![response]);
        let out = runtime().block_on(execute(
            &client().unwrap(),
            input(),
            Ok(url),
            local,
            TIMEOUT,
        ));
        assert_eq!(out.error.as_deref(), Some("response exceeds 8 MiB"));
        server.join().unwrap();
    }
}
