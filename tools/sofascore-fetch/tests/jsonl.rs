use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn process_handles_multiple_requests() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sofascore_fetch"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{\"id\":1,\"path\":\"event/1\",\"max_requests\":0}\n{\"id\":2,\"path\":\"../escape\"}\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let lines: Vec<serde_json::Value> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[0]["requests"], 0);
    assert_eq!(lines[1]["id"], 2);
    assert_eq!(lines[1]["requests"], 0);
    assert!(lines.iter().all(|line| line["error"].is_string()));
}
