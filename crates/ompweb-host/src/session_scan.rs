//! R7: Session Projection Shadow (doc 15 / v4 R7).
//!
//! Standalone Rust scan of a sessions root, mirroring what the Node
//! session-reader list path computes: per-file title (fixed 256-byte slot
//! with padding stripped), entry/message counts, mtime and size. The Node
//! shadow test compares this output against `listAllSessions` on the same
//! fixture root — semantic mismatch threshold = 0 for the fixture set.

use crate::mini_json::JsonValue;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub struct SessionProjection {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub parent_session: String,
    pub created: String,
    pub title: String,
    pub first_message: String,
    pub lines: usize,
    pub messages: usize,
    pub bytes: u64,
    pub mtime_ms: i64,
}

pub fn collect_session_files(root: &Path) -> Vec<PathBuf> {
    collect_session_files_inner(root, true)
}

fn collect_session_files_inner(root: &Path, allow_loose_files: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Per-session artifact directories are literally the session
                // file name minus `.jsonl` (`<ts>_<uuid>`). They hold subagent
                // transcripts and sidecars, NOT sessions — skip them so the
                // sidebar never lists `CodeQualityReview.jsonl` etc. Real
                // project dirs (cwd slugs) never match the session pattern.
                if let Some(name) = entry.file_name().to_str() {
                    if !is_session_file_name(&format!("{name}.jsonl")) {
                        files.extend(collect_session_files_inner(&path, false));
                    }
                }
            } else if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".jsonl")
                    && (allow_loose_files
                        || is_session_file_name(name)
                        || is_session_header_file(&path))
                {
                    files.push(path);
                }
            }
        }
    }
    files.sort();
    files
}

/// Accept legacy/imported session files with non-standard names only when
/// their bounded prefix proves they contain a session header.
fn is_session_header_file(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    for line in raw.lines().take(32) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = JsonValue::parse(line) else {
            return false;
        };
        return value.get(&["type"]).and_then(|v| v.as_str()) == Some("session")
            && value
                .get(&["id"])
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
    }
    false
}

/// Mirror of the Node `isOmpSessionFileName`: true only for omp session files
/// (`<timestamp>_<uuid>.jsonl`, ISO-dash or compact timestamp forms). Subagent
/// transcripts and other artifacts never match, keeping R7 shadow parity with
/// the Node scanner.
pub fn is_session_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    let Some(index) = stem.find('_') else {
        return false;
    };
    let (ts, body) = stem.split_at(index);
    let body = &body[1..];
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    is_compact_timestamp(ts) || is_iso_timestamp(ts)
}

fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// `20260103T030000` (15 chars: digits, `T` at index 8).
fn is_compact_timestamp(ts: &str) -> bool {
    if ts.len() != 15 {
        return false;
    }
    let bytes = ts.as_bytes();
    (0..15).all(|i| {
        if i == 8 {
            bytes[i] == b'T'
        } else {
            bytes[i].is_ascii_digit()
        }
    })
}

/// `2026-08-27T16-58-53Z` (20) or `2026-08-27T16-58-53-862Z` (24).
fn is_iso_timestamp(ts: &str) -> bool {
    let bytes = ts.as_bytes();
    if ts.len() == 20 {
        is_all_digits(&ts[0..4])
            && bytes[4] == b'-'
            && is_all_digits(&ts[5..7])
            && bytes[7] == b'-'
            && is_all_digits(&ts[8..10])
            && bytes[10] == b'T'
            && is_all_digits(&ts[11..13])
            && bytes[13] == b'-'
            && is_all_digits(&ts[14..16])
            && bytes[16] == b'-'
            && is_all_digits(&ts[17..19])
            && bytes[19] == b'Z'
    } else if ts.len() == 24 {
        is_all_digits(&ts[0..4])
            && bytes[4] == b'-'
            && is_all_digits(&ts[5..7])
            && bytes[7] == b'-'
            && is_all_digits(&ts[8..10])
            && bytes[10] == b'T'
            && is_all_digits(&ts[11..13])
            && bytes[13] == b'-'
            && is_all_digits(&ts[14..16])
            && bytes[16] == b'-'
            && is_all_digits(&ts[17..19])
            && bytes[19] == b'-'
            && is_all_digits(&ts[20..23])
            && bytes[23] == b'Z'
    } else {
        false
    }
}

/// Read the fixed 256-byte title slot (line 1, left-padded). Mirrors the
/// Node readTitleSlot contract: title text before the padding, or "" when
/// the header is not the title line.
fn read_title_slot(raw: &str) -> String {
    let first_line = raw.lines().next().unwrap_or("");
    if !first_line.starts_with("{\"type\":\"title\"") {
        return String::new();
    }
    match JsonValue::parse(first_line) {
        Ok(v) => v
            .get(&["title"])
            .and_then(|t| t.as_str())
            .map(|t| t.trim_end_matches([' ', '\u{00A0}']).to_string())
            .unwrap_or_default(),
        Err(_) => String::new(),
    }
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// List-scan prefix window (bytes) — mirrors the Node scanner's
/// SESSION_LIST_PREFIX_BYTES. Session metadata (title slot, session header,
/// first message, prefix message count) all live at the head of the file;
/// reading only this window keeps the scan O(total-head-bytes) instead of
/// O(total-file-bytes) — a 1 GiB session directory must not stall the list.
/// The rare file whose prefix carries no message falls back to the streaming
/// scan below, bounded by the load ceiling and the per-line cap (Node parity).
const LIST_PREFIX_BYTES: u64 = 4096;

/// Files past this size are never opened by omp-web (Node MAX_SESSION_LOAD_BYTES
/// parity): skip the streaming scan so oversized sessions stay listed (their
/// open route answers 413) instead of stalling the list on a multi-GB read.
const MAX_SESSION_LOAD_BYTES: u64 = 1024 * 1024 * 1024;

/// First user-visible text of a message content value: a plain string, or
/// an array of text blocks ([{"type":"text","text":"..."}]). Mirrors the
/// Node extractTextFromContent contract (240-char bound).
fn extract_message_text(value: &JsonValue) -> String {
    if let Some(text) = value.as_str() {
        return text.chars().take(240).collect();
    }
    if let JsonValue::Arr(items) = value {
        let mut out = String::new();
        for item in items {
            if let JsonValue::Obj(entries) = item {
                let is_text = entries
                    .iter()
                    .any(|(k, v)| k == "type" && v.as_str() == Some("text"));
                if is_text {
                    if let Some(text) = entries
                        .iter()
                        .find(|(k, _)| k == "text")
                        .and_then(|(_, v)| v.as_str())
                    {
                        if !out.is_empty() {
                            out.push(' ');
                        }
                        out.push_str(text);
                        if out.chars().count() >= 240 {
                            break;
                        }
                    }
                }
            }
        }
        out.chars().take(240).collect()
    } else {
        String::new()
    }
}

/// omp records a `/skill:` first prompt's user text inside a
/// `custom_message` (customType "skill-prompt") as a trailing
/// "User: <prompt>" line — there is no role:"user" message entry. Recover
/// that trailer so the session is not invisible to the session list.
/// Without the trailer there is no user text to recover (falling back to
/// the whole skill body would name the session after the skill).
fn extract_skill_prompt_user(value: &JsonValue) -> Option<String> {
    if value.get(&["type"]).and_then(|t| t.as_str()) != Some("custom_message") {
        return None;
    }
    if value.get(&["customType"]).and_then(|t| t.as_str()) != Some("skill-prompt") {
        return None;
    }
    let content = value.get(&["content"])? .as_str()?;
    // Without a "User: " trailer there is no user prompt to recover (rsplit
    // would otherwise yield the whole skill body as the "first message").
    if !content.contains("User: ") {
        return None;
    }
    // The user's prompt follows the LAST "User: " trailer; the skill body can
    // contain its own "User:" text.
    let user = content
        .rsplit("User: ")
        .next()
        .unwrap_or("")
        .trim();
    if user.is_empty() {
        return None;
    }
    // The trailer can carry a web slash-command wrapper ("/goal", "/plan",
    // "/fix" send "Prefix:\n\n<task>"); drop it so the session reads as the
    // task itself.
    let lines: Vec<&str> = user.split('\n').collect();
    let unwrapped = if lines.len() >= 2 && lines[0].ends_with(':') && lines[1].trim().is_empty() {
        lines[2..].join("\n").trim().to_string()
    } else {
        user.to_string()
    };
    let final_text = if unwrapped.is_empty() { user.to_string() } else { unwrapped };
    Some(final_text.chars().take(240).collect())
}

/// Stream lines until the first textual user entry (message/role:user text or
/// a skill-prompt `"User: "` trailer). A single line past Node's ~512 MiB
/// string cap makes the Node scanner give up on the first message; mirror that
/// instead of allocating unboundedly. Torn lines are skipped, as the lenient
/// parsers do.
fn scan_first_user_message(path: &Path) -> String {
    const CHUNK_BYTES: usize = 1 << 20;
    const LINE_CAP_BYTES: usize = 512 * 1024 * 1024;
    use std::io::Read as _;
    let mut text = String::new();
    let Ok(file) = fs::File::open(path) else { return text };
    let mut reader = std::io::BufReader::with_capacity(CHUNK_BYTES, file);
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; CHUNK_BYTES];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return text,
        };
        let mut start = 0usize;
        while let Some(rel) = chunk[start..n].iter().position(|&b| b == b'\n') {
            let end = start + rel;
            pending.extend_from_slice(&chunk[start..end]);
            start = end + 1;
            if pending.len() > LINE_CAP_BYTES {
                return text; // mirror Node's caught RangeError
            }
            let stopped = consider_streamed_line(&String::from_utf8_lossy(&pending), &mut text);
            pending.clear();
            if stopped {
                return text;
            }
        }
        pending.extend_from_slice(&chunk[start..n]);
        if pending.len() > LINE_CAP_BYTES {
            return text;
        }
    }
    if !pending.is_empty() && pending.len() <= LINE_CAP_BYTES {
        consider_streamed_line(&String::from_utf8_lossy(&pending), &mut text);
    }
    text
}

/// One streamed line; true stops the scan. The `'"user"'`/`"skill-prompt"`
/// prefilter keeps ordinary lines off the JSON parser (Node parity; note
/// skill-prompt lines never contain the quoted `"user"` token).
fn consider_streamed_line(line: &str, text: &mut String) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed.contains("\"user\"") && !trimmed.contains("skill-prompt") {
        return false;
    }
    let Ok(value) = JsonValue::parse(trimmed) else { return false };
    match value.get(&["type"]).and_then(|t| t.as_str()).unwrap_or("") {
        "message" => {
            if value.get(&["message", "role"]).and_then(|r| r.as_str()) != Some("user") {
                return false;
            }
            if let Some(content) = value.get(&["message", "content"]) {
                *text = extract_message_text(content);
                return !text.is_empty();
            }
            false
        }
        "custom_message" => {
            if let Some(found) = extract_skill_prompt_user(&value) {
                *text = found;
                return true;
            }
            false
        }
        _ => false,
    }
}

/// Scan one file into a projection (head-window read, Node-parity).
pub fn project_file(path: &Path) -> Result<SessionProjection, String> {
    let file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    let head = size.min(LIST_PREFIX_BYTES) as usize;
    let mut buf = vec![0u8; head];
    if head > 0 {
        use std::io::Read;
        let mut file = file;
        file.read_exact(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
    }
    let raw = String::from_utf8_lossy(&buf);
    let mut lines = 0usize;
    let mut messages = 0usize;
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut parent_session = String::new();
    let mut created = String::new();
    let mut first_message = String::new();
    let mut prefix_fallback = String::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        lines += 1;
        if let Ok(value) = JsonValue::parse(line) {
            let kind = value.get(&["type"]).and_then(|t| t.as_str()).unwrap_or("");
            if kind == "message" {
                messages += 1;
                let role = value
                    .get(&["message", "role"])
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                if first_message.is_empty() && role == "user" {
                    if let Some(content) = value.get(&["message", "content"]) {
                        first_message = extract_message_text(content);
                    }
                } else if prefix_fallback.is_empty() && matches!(role, "assistant" | "developer") {
                    // Assistant/developer text is only a fallback: Node applies
                    // it after the streaming scan, so a real user prompt past the
                    // prefix must win (fallback-ordering parity).
                    if let Some(content) = value.get(&["message", "content"]) {
                        prefix_fallback = extract_message_text(content);
                    }
                }
            } else if kind == "session" {
                session_id = value
                    .get(&["id"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                cwd = value
                    .get(&["cwd"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                parent_session = value
                    .get(&["parentSession"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                created = value
                    .get(&["timestamp"])
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            } else if kind == "custom_message" {
                if first_message.is_empty() {
                    if let Some(text) = extract_skill_prompt_user(&value) {
                        first_message = text;
                    }
                }
            }
        }
    }
    if session_id.is_empty() {
        // Fallback: derive the id from the file name (<ts>_<uuid>.jsonl).
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            session_id = stem.rsplit('_').next().unwrap_or(stem).to_string();
        }
    }
    // Streaming fallback (Node scanFirstUserMessage parity): injected context
    // (rules, skills, memory recall) can push the first user message past the
    // prefix window AND past any bounded extension window. Files past the load
    // ceiling cannot be opened anyway, so skip the scan.
    if first_message.is_empty() && size > LIST_PREFIX_BYTES && size <= MAX_SESSION_LOAD_BYTES {
        first_message = scan_first_user_message(path);
    }
    if first_message.is_empty() {
        first_message = prefix_fallback;
    }
    // Display title: when the title slot is empty, inject the opening
    // message so the sidebar never shows a bare "(no messages)" row.
    let title = read_title_slot(&raw);
    let display_title = if title.is_empty() {
        first_message.chars().take(120).collect()
    } else {
        title
    };
    Ok(SessionProjection {
        path: path.to_string_lossy().to_string(),
        id: session_id,
        cwd,
        parent_session,
        created,
        title: display_title,
        first_message,
        lines,
        messages,
        bytes: size,
        mtime_ms: mtime_ms(path),
    })
}

/// Scan the whole root; returns projections sorted by path.
pub fn scan_root(root: &Path) -> Result<Vec<SessionProjection>, String> {
    let files = collect_session_files(root);
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        out.push(project_file(&file)?);
    }
    Ok(out)
}

/// Minimal JSON array serialization for the CLI output (zero deps).
pub fn projections_to_json(items: &[SessionProjection]) -> String {
    let mut out = String::from("[");
    for (i, p) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"path\":{},\"id\":{},\"cwd\":{},\"parentSession\":{},\"created\":{},\"title\":{},\"firstMessage\":{},\"lines\":{},\"messages\":{},\"bytes\":{},\"mtime_ms\":{}}}",
            json_string(&p.path),
            json_string(&p.id),
            json_string(&p.cwd),
            json_string(&p.parent_session),
            json_string(&p.created),
            json_string(&p.title),
            json_string(&p.first_message),
            p.lines,
            p.messages,
            p.bytes,
            p.mtime_ms,
        ));
    }
    out.push(']');
    out
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ompweb-scan-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn projection_includes_r10_fields() {
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_0000test00000000000000000000abcd.jsonl");
        fs::write(
            &file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000abcd\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/work/proj\",\"parentSession\":\"/work/proj/20260101T000000_0000parent0000000000000000000000.jsonl\"}\n\
             {\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"first hello\"}}\n",
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.id, "0000test00000000000000000000abcd");
        assert_eq!(p.cwd, "/work/proj");
        assert_eq!(p.created, "2026-01-15T12:00:00Z");
        assert_eq!(p.first_message, "first hello");
        assert_eq!(p.messages, 1);
        assert!(p.parent_session.contains("0000parent"));
        fs::remove_file(&file).ok();
    }

    #[test]
    fn session_file_name_filter_matches_omp_and_rejects_artifacts() {
        assert!(is_session_file_name(
            "2026-08-27T16-58-53-862Z_01a04429-0426-71ee-9345-c66edc32e851.jsonl"
        ));
        assert!(is_session_file_name(
            "20260103T030000_00000000002a-4a0d-4f5e-9c1b-000000051336.jsonl"
        ));
        assert!(is_session_file_name("2026-08-27T16-58-53Z_01a04429.jsonl"));
        assert!(!is_session_file_name("CodeQualityReview.jsonl"));
        assert!(!is_session_file_name("sec-review-eval.jsonl"));
        assert!(!is_session_file_name("10.bash.log"));
        assert!(!is_session_file_name("2026-08-27.txt"));
    }

    #[test]
    fn first_message_from_text_blocks_and_title_fallback() {
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_0000test00000000000000000000blk1.jsonl");
        fs::write(
            &file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000blk1\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n\
             {\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello blocks\"}]}}\n",
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "hello blocks");
        assert_eq!(p.title, "hello blocks");
        fs::remove_file(&file).ok();
    }

    #[test]
    fn skill_prompt_first_prompt_recovers_user_text() {
        // Regression: a `/skill:` first prompt stores the user's text in a
        // custom_message/skill-prompt trailer, not a role:"user" message, so
        // the session must still expose a first message (else it is invisible).
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_skill0000000000000000000001.jsonl");
        fs::write(
            &file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"skill0000000000000000000001\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n\
             {\"type\":\"custom_message\",\"customType\":\"skill-prompt\",\"content\":\"[IMPORTANT: User invoked the skill]\\n\\n# skill body\\n\\nUser: Do you have access to the MR? \"}\n",
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "Do you have access to the MR?");
        assert_eq!(p.title, "Do you have access to the MR?");
        assert_eq!(p.messages, 0);
        fs::remove_file(&file).ok();
    }

    #[test]
    fn skill_prompt_past_prefix_window_is_recovered() {
        // The 4 KiB prefix can truncate a large skill-prompt line; the bounded
        // extension pass must still find the trailing "User: " prompt.
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_skill0000000000000000000002.jsonl");
        let big = "x".repeat(5000);
        fs::write(
            &file,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"skill0000000000000000000002\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}}\n\
                 {{\"type\":\"custom_message\",\"customType\":\"skill-prompt\",\"content\":\"{big}\\nUser: find the bug\"}}\n"
            ),
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "find the bug");
        assert_eq!(p.title, "find the bug");
        assert_eq!(p.messages, 0);
        fs::remove_file(&file).ok();
    }

    #[test]
    fn skill_prompt_without_user_marker_is_not_a_first_message() {
        // A skill-prompt with no "User: " trailer carries only the skill body;
        // falling back to the whole body would name the session after the
        // skill, so it must not surface as a first message.
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_skill0000000000000000000003.jsonl");
        fs::write(
            &file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"skill0000000000000000000003\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n\
             {\"type\":\"custom_message\",\"customType\":\"skill-prompt\",\"content\":\"[IMPORTANT: User invoked the skill]\\n\\n# skill body\\n\\nNo trailer here\"}\n",
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "");
        fs::remove_file(&file).ok();
    }

    #[test]
    fn skill_prompt_strips_web_slash_wrapper() {
        // "/goal <task>" is sent as "Work toward this goal ...:\n\n<task>...";
        // the recovered first message must start at the task, not the wrapper.
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_skill0000000000000000000004.jsonl");
        fs::write(
            &file,
            "{\"type\":\"session\",\"version\":3,\"id\":\"skill0000000000000000000004\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n\
             {\"type\":\"custom_message\",\"customType\":\"skill-prompt\",\"content\":\"# skill body\\n\\nUser: Work toward this goal for the rest of the session:\\n\\nFix the sidebar bug\\n\\nTreat it as the objective to prioritize when deciding what to do next.\"}\n",
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "Fix the sidebar bug\n\nTreat it as the objective to prioritize when deciding what to do next.");
        fs::remove_file(&file).ok();
    }

    #[test]
    fn first_message_past_the_extension_window_is_streamed() {
        // Rules/skills injections beyond any fixed window must not hide the prompt.
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_0000test00000000000000000000str1.jsonl");
        let injected = format!(
            "{{\"type\":\"custom_message\",\"customType\":\"rules\",\"content\":\"{}\",\"display\":false}}",
            "r".repeat(70_000)
        );
        fs::write(
            &file,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000str1\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}}\n{}\n\
                 {{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":\"deep prompt\"}}}}\n",
                injected
            ),
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "deep prompt");
        fs::remove_file(&file).ok();
    }

    #[test]
    fn skill_prompt_past_the_extension_window_is_streamed() {
        // Same guarantee for a `/skill:` prompt deeper than any read window:
        // the streamed line still yields its trailing "User: " text.
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_skill0000000000000000000005.jsonl");
        let body = "s".repeat(80_000);
        fs::write(
            &file,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"skill0000000000000000000005\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}}\n\
                 {{\"type\":\"custom_message\",\"customType\":\"skill-prompt\",\"content\":\"{}\\nUser: find the bug\"}}\n",
                body
            ),
        )
        .unwrap();
        let p = project_file(&file).unwrap();
        assert_eq!(p.first_message, "find the bug");
        fs::remove_file(&file).ok();
    }

    #[test]
    fn prefix_assistant_text_does_not_shadow_a_deeper_user_prompt() {
        // Node fallback-ordering parity: assistant text in the 4 KiB prefix is
        // only a fallback (no user message anywhere), never a veto on the
        // streaming scan.
        let dir = fixture_dir();
        let injected = format!(
            "{{\"type\":\"custom_message\",\"customType\":\"rules\",\"content\":\"{}\",\"display\":false}}",
            "r".repeat(20_000)
        );
        let deeper = dir.join("20260115T120000_0000test00000000000000000000ord1.jsonl");
        fs::write(
            &deeper,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000ord1\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}}\n\
                 {{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{{\"role\":\"assistant\",\"content\":\"prefilled\"}}}}\n{}\n\
                 {{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"message\":{{\"role\":\"user\",\"content\":\"real question\"}}}}\n",
                injected
            ),
        )
        .unwrap();
        assert_eq!(project_file(&deeper).unwrap().first_message, "real question");
        fs::remove_file(&deeper).ok();

        // Assistant-only prefix still yields the assistant text as fallback.
        let only = dir.join("20260115T120000_0000test00000000000000000000ord2.jsonl");
        fs::write(
            &only,
            "{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000ord2\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n\
             {\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"message\":{\"role\":\"assistant\",\"content\":\"prefilled\"}}\n",
        )
        .unwrap();
        assert_eq!(project_file(&only).unwrap().first_message, "prefilled");
        fs::remove_file(&only).ok();
    }

    #[test]
    fn oversized_file_skips_the_streaming_scan_but_stays_listed() {
        // Past MAX_SESSION_LOAD_BYTES the projection must still be produced
        // (the list keeps the row, the open route answers 413) without reading
        // a multi-gigabyte file. Header-only sparse fixture, so no hang.
        use std::io::Write as _;
        let dir = fixture_dir();
        let file = dir.join("20260115T120000_0000test00000000000000000000big1.jsonl");
        let mut f = fs::File::create(&file).unwrap();
        f.write_all(b"{\"type\":\"session\",\"version\":3,\"id\":\"0000test00000000000000000000big1\",\"timestamp\":\"2026-01-15T12:00:00Z\",\"cwd\":\"/p\"}\n")
            .unwrap();
        f.set_len(2 * 1024 * 1024 * 1024).unwrap(); // sparse, no disk cost
        drop(f);
        let p = project_file(&file).unwrap();
        assert_eq!(p.id, "0000test00000000000000000000big1");
        assert_eq!(p.first_message, "");
        fs::remove_file(&file).ok();
    }

}
