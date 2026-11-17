//! FileSystem Adapter for the report check.
//!
//!   check-report <report-dir>
//!
//! Reads a report directory from disk into a Report Bundle, passes it with the
//! embedded Report Contract assets to the Report Verifier, and formats the
//! result for the terminal. All filesystem access for the check lives here.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use codebase_map::{verify_report, Contract, REQUIRED_FILES};
use serde_json::{Map, Value};

fn main() -> ExitCode {
    let Some(target) = std::env::args_os().nth(1).filter(|t| !t.is_empty()) else {
        eprintln!("usage: check-report <report-dir>");
        return ExitCode::from(2);
    };
    let dir = absolute(Path::new(&target));
    let shown = dir.display();

    match std::fs::metadata(&dir) {
        Err(_) => {
            eprintln!("report directory not found: {shown}");
            return ExitCode::from(2);
        }
        Ok(info) if !info.is_dir() => {
            eprintln!("not a directory: {shown}");
            return ExitCode::from(2);
        }
        Ok(_) => {}
    }

    let mut bundle = Map::new();
    for name in REQUIRED_FILES {
        // Unreadable and missing are the same to the verifier; invalid UTF-8 is
        // replaced, not rejected, as Node's readFile(path, 'utf8') does.
        if let Ok(bytes) = std::fs::read(dir.join(name)) {
            let contents = String::from_utf8_lossy(&bytes).into_owned();
            bundle.insert(name.to_string(), Value::String(contents));
        }
    }

    let errors = verify_report(&Value::Object(bundle), &Contract::embedded());
    if errors.is_empty() {
        println!("report check passed: {shown}");
        return ExitCode::SUCCESS;
    }

    eprintln!("report check failed: {shown}\n");
    for error in &errors {
        eprintln!("  x {error}");
    }
    let plural = if errors.len() == 1 { "" } else { "s" };
    eprintln!("\n{} problem{plural}", errors.len());
    ExitCode::from(1)
}

/// Node's `path.resolve`: absolute and lexically normalised, symlinks kept.
fn absolute(target: &Path) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(target);
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}
