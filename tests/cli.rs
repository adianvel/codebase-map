use std::process::{Command, Output};

const EXAMPLE: &str = "examples/tiny-app/reports/codebase-map/tiny-app";

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_check-report"))
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("binary runs")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn passes_the_example_report() {
    let out = run(&[EXAMPLE]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out.stderr));
    assert!(text(&out.stdout).starts_with("report check passed: /"));
    assert!(text(&out.stdout).trim_end().ends_with(EXAMPLE));
}

#[test]
fn usage_without_an_argument_exits_2() {
    let out = run(&[]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(text(&out.stderr), "usage: check-report <report-dir>\n");
}

#[test]
fn an_empty_argument_is_no_argument() {
    let out = run(&[""]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(text(&out.stderr), "usage: check-report <report-dir>\n");
}

#[test]
fn missing_directory_is_fatal() {
    let out = run(&["no-such-dir-xyz"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).starts_with("report directory not found: /"));
}

#[test]
fn a_file_is_not_a_report_directory() {
    let out = run(&["SKILL.md"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out.stderr).starts_with("not a directory: /"));
}

#[test]
fn an_empty_directory_lists_every_missing_file() {
    let dir = std::env::temp_dir().join(format!("cm-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = run(&[dir.to_str().unwrap()]);
    let stderr = text(&out.stderr);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr.starts_with(&format!("report check failed: {}\n\n", dir.display())));
    for name in [
        "index.json",
        "context.md",
        "architecture.html",
        "evidence.md",
    ] {
        assert!(
            stderr.contains(&format!("  x missing report file: {name}\n")),
            "{stderr}"
        );
    }
    assert!(stderr.ends_with("\n4 problems\n"), "{stderr}");
    std::fs::remove_dir_all(dir).unwrap();
}
