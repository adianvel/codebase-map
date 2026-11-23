//! Replays every Report Verifier call the Node test suite made (recorded from
//! scripts/report-verifier.mjs at commit 4561b09) and expects the Rust
//! verifier to return the same errors in the same order.

use codebase_map::{verify_report, Contract};
use serde_json::Value;

const CASES: &str = include_str!("fixtures/node-verifier-cases.jsonl");

fn option(options: &Value, key: &str, default: Option<Value>) -> Option<Value> {
    match options.get(key) {
        None => None,
        Some(Value::String(s)) if s == "$default" => default,
        Some(custom) => custom.get("value").cloned(),
    }
}

/// V8 and serde word JSON syntax errors differently; the prefix is the contract.
fn comparable(error: &str) -> &str {
    const INVALID_JSON: &str = "index.json is not valid JSON:";
    if error.starts_with(INVALID_JSON) {
        INVALID_JSON
    } else {
        error
    }
}

#[test]
fn rust_verifier_matches_every_recorded_node_result() {
    let embedded = Contract::embedded();
    let mut count = 0;
    for (line, raw) in CASES.lines().enumerate() {
        let case: Value = serde_json::from_str(raw).expect("valid case");
        let options = &case["options"];
        let contract = Contract {
            template_html: option(
                options,
                "templateHtml",
                embedded.template_html.clone().map(Value::String),
            )
            .map(|v| v.as_str().unwrap_or_default().to_string()),
            marks: option(options, "marks", embedded.marks.clone()),
            geometry: option(options, "geometry", embedded.geometry.clone()),
        };
        let expected: Vec<String> = serde_json::from_value(case["errors"].clone()).unwrap();
        let actual = verify_report(&case["bundle"], &contract);
        let expected: Vec<&str> = expected.iter().map(|e| comparable(e)).collect();
        let actual: Vec<&str> = actual.iter().map(|e| comparable(e)).collect();
        assert_eq!(actual, expected, "case on line {}", line + 1);
        count += 1;
    }
    assert_eq!(count, 53, "every recorded case replays");
}
