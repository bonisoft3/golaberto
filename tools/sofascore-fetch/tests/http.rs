use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::thread;
use std::time::Duration;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start() -> (Server, String) {
    let address = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string();
    let mut child = Server(Command::new(env!("CARGO_BIN_EXE_sofascore_fetch"))
        .args(["--listen", &address])
        .spawn()
        .unwrap());
    for _ in 0..100 {
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!("server exited before listening: {status}");
        }
        if let Ok(mut stream) = TcpStream::connect(&address) {
            stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
            let mut response = String::new();
            if stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").is_ok()
                && stream.read_to_string(&mut response).is_ok()
                && response == "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
            {
                return (child, address);
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("server did not listen");
}

fn call(address: &str, request: &str) -> (u16, serde_json::Value) {
    let mut stream = TcpStream::connect(address).unwrap_or_else(|error| panic!("{request:?}: connect {address}: {error}"));
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap_or_else(|error| panic!("{request:?}: {error}; response: {response:?}"));
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap())
}

fn post(address: &str, body: &str) -> (u16, serde_json::Value) {
    call(address, &format!("POST /fetch HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}", body.len()))
}

#[test]
fn http_fetch_refuses_without_reaching_the_provider() {
    let (_server, address) = start();
    // A path escaping /api/v1/ is refused before any request is made.
    let (status, out) = post(&address, r#"{"id":"r1","path":"../escape"}"#);
    assert_eq!(status, 200);
    assert_eq!(out["id"], "r1");
    assert_eq!(out["requests"], 0);
    assert_eq!(out["error"], "URL outside allowed SofaScore API");
    let (status, out) = post(&address, r#"{"id":"r2","path":"event/1","max_requests":0}"#);
    assert_eq!(status, 200);
    assert_eq!(out["error"], "request budget exhausted");
    let (status, out) = post(&address, r#"{"path":"event/1","method":"DELETE"}"#);
    assert_eq!(status, 200);
    assert!(out["error"].as_str().unwrap().starts_with("invalid request"));
}

#[test]
fn http_protocol_is_post_fetch_only() {
    let (_server, address) = start();
    assert_eq!(call(&address, "GET /fetch HTTP/1.1\r\nHost: x\r\n\r\n").0, 405);
    assert_eq!(call(&address, "POST /other HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n").0, 404);
    assert_eq!(call(&address, "POST /fetch HTTP/1.1\r\nHost: x\r\n\r\n").0, 411);
    assert_eq!(call(&address, "POST /fetch HTTP/1.1\r\nHost: x\r\nContent-Length: 70000\r\n\r\n").0, 413);
    assert_eq!(call(&address, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n").0, 200);
}
