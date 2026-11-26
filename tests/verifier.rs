//! Behaviour of the Report Verifier at its public seam. Exact Node parity for
//! the whole old suite lives in tests/parity.rs; these read as the contract.

use codebase_map::{verify_report, Contract, REQUIRED_FILES};
use serde_json::{json, Value};

const EXAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/examples/tiny-app/reports/codebase-map/tiny-app"
);

fn example() -> serde_json::Map<String, Value> {
    REQUIRED_FILES
        .iter()
        .map(|name| {
            (
                name.to_string(),
                Value::String(std::fs::read_to_string(format!("{EXAMPLE}/{name}")).unwrap()),
            )
        })
        .collect()
}

fn errors_with(name: &str, contents: Value) -> Vec<String> {
    let mut bundle = example();
    bundle.insert(name.into(), contents);
    verify_report(&Value::Object(bundle), &Contract::embedded())
}

fn example_index() -> Value {
    serde_json::from_str(example()["index.json"].as_str().unwrap()).unwrap()
}

#[test]
fn the_committed_example_report_passes() {
    assert_eq!(
        verify_report(&Value::Object(example()), &Contract::embedded()),
        Vec::<String>::new()
    );
}

#[test]
fn a_bundle_must_be_an_object() {
    assert_eq!(
        verify_report(&json!("not-a-bundle"), &Contract::embedded()),
        ["report bundle must be an object"]
    );
}

#[test]
fn invalid_json_is_named() {
    let errors = errors_with("index.json", json!("{bad"));
    assert!(
        errors[0].starts_with("index.json is not valid JSON: "),
        "{errors:?}"
    );
}

#[test]
fn a_dangling_relationship_is_reported_with_its_value() {
    let mut index = example_index();
    index["relationships"][0]["target"] = json!(5);
    let errors = errors_with("index.json", Value::String(index.to_string()));
    assert_eq!(
        errors,
        ["index.json.relationships[0].target \"5\" is not a concept id"]
    );
}

#[test]
fn a_bad_confidence_is_quoted_like_json() {
    let mut index = example_index();
    index["concepts"][0]["confidence"] = json!(1.0);
    let errors = errors_with("index.json", Value::String(index.to_string()));
    assert_eq!(
        errors,
        ["index.json.concepts[0].confidence must be one of confirmed, inferred, unknown (got 1)"]
    );
}

#[test]
fn a_null_entry_is_reported_not_fatal() {
    let mut index = example_index();
    index["flows"][0] = Value::Null;
    let errors = errors_with("index.json", Value::String(index.to_string()));
    assert!(
        errors.contains(&"index.json.flows[0].id must be a non-empty string".to_string()),
        "{errors:?}"
    );
    assert!(
        errors.contains(&"index.json.flows[0].evidence must be an array".to_string()),
        "{errors:?}"
    );
}

#[test]
fn context_md_has_a_byte_budget() {
    let errors = errors_with("context.md", Value::String("é".repeat(6145)));
    assert_eq!(
        errors,
        ["context.md is 12290 bytes; the budget is 12288 so it stays loadable whole"]
    );
}

#[test]
fn secret_shaped_literals_are_flagged() {
    let errors = errors_with("evidence.md", json!("token ghp_abcdefghijklmnopqrstuvwxyz"));
    assert_eq!(
        errors,
        ["evidence.md looks like it contains a GitHub token"]
    );
}

#[test]
fn a_glued_technology_word_does_not_back_the_mark() {
    let index = example_index()
        .to_string()
        .replace("TypeScript", "TypeScriptextra")
        .replace("tsconfig", "tsconfigextra");
    let errors = errors_with("index.json", Value::String(index));
    assert!(
        errors
            .iter()
            .any(|e| e.contains("the \"typescript\" mark is not backed by index.json")),
        "{errors:?}"
    );
}

#[test]
fn a_technology_keyword_at_the_end_of_a_summary_backs_the_mark() {
    let mut index: Value = serde_json::from_str(
        &example_index()
            .to_string()
            .replace("TypeScript", "PlainScript")
            .replace("tsconfig", "buildfile"),
    )
    .unwrap();
    let summary = index["files"][0]["summary"].as_str().unwrap();
    index["files"][0]["summary"] = json!(format!("{summary} typescript"));
    let errors = errors_with("index.json", Value::String(index.to_string()));
    assert!(
        errors
            .iter()
            .all(|e| !e.contains("not backed by index.json")),
        "{errors:?}"
    );
}

#[test]
fn the_first_stated_font_size_is_the_one_that_counts() {
    let html = example()["architecture.html"].as_str().unwrap().replacen(
        "</style>",
        ".node-title { font-size: 99px; }</style>",
        1,
    );
    let errors = errors_with("architecture.html", Value::String(html));
    assert!(
        errors.iter().all(|e| !e.contains("characters")),
        "{errors:?}"
    );
}

#[test]
fn a_label_without_a_stated_font_size_is_not_budgeted() {
    let html = example()["architecture.html"].as_str().unwrap().replacen(
        ".node-title {\n      fill: var(--text);\n      font-size: 13px;\n",
        ".node-title {\n      fill: var(--text);\n",
        1,
    );
    let errors = errors_with("architecture.html", Value::String(html));
    assert!(
        errors.iter().all(|e| !e.contains("characters")),
        "{errors:?}"
    );
}

#[test]
fn a_nudged_tile_breaks_the_layout_with_coordinates() {
    let html =
        example()["architecture.html"]
            .as_str()
            .unwrap()
            .replacen(r#"x="90""#, r#"x="5""#, 1);
    let errors = errors_with("architecture.html", Value::String(html));
    assert!(
        errors
            .iter()
            .any(|e| e.contains("runs past the viewBox padding")),
        "{errors:?}"
    );
}

#[test]
fn without_contract_assets_the_check_says_what_it_cannot_verify() {
    let errors = verify_report(&Value::Object(example()), &Contract::default());
    assert_eq!(
        errors,
        [
            "diagram geometry was not supplied; layout cannot be verified against docs/diagram-geometry.json",
            "Tiny app architecture overview: report draws the \"typescript\" mark but docs/technology-marks.json was not read; the path cannot be verified",
            "report template was not supplied; palette cannot be verified against docs/report-template.html",
        ]
    );
}

#[test]
fn the_technology_marks_asset_is_vendored_and_complete() {
    let marks = Contract::embedded()
        .marks
        .expect("docs/technology-marks.json parses");
    assert_eq!(marks["box"], json!(24));
    let list = marks["marks"].as_array().unwrap();
    assert!(
        list.len() >= 15,
        "the set should cover the stacks a scan usually names"
    );
    let mut slugs: Vec<&str> = list.iter().map(|m| m["slug"].as_str().unwrap()).collect();
    slugs.sort();
    slugs.dedup();
    assert_eq!(slugs.len(), list.len(), "slugs are unique");
    for mark in list {
        assert!(!mark["name"].as_str().unwrap().is_empty());
        let keywords = mark["keywords"].as_array().unwrap();
        assert!(
            !keywords.is_empty()
                && keywords
                    .iter()
                    .all(|k| k.as_str().unwrap().chars().count() > 2)
        );
        let path = mark["path"].as_str().unwrap();
        let mut start = path.trim_start_matches('M').trim_start_matches('-').chars();
        assert!(
            path.starts_with('M') && start.next().is_some_and(|c| c.is_ascii_digit() || c == '.')
        );
        assert!(
            !path.contains("  "),
            "{} path is not normalised",
            mark["slug"]
        );
    }
}

#[test]
fn the_diagram_geometry_asset_has_every_number_the_layout_check_needs() {
    let geometry = Contract::embedded()
        .geometry
        .expect("docs/diagram-geometry.json parses");
    let mut keys: Vec<&str> = geometry
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "arrowTolerance",
            "canvasPadding",
            "footprintHeight",
            "footprintWidth",
            "glyphAdvanceEm",
            "labelInset"
        ]
    );
    assert!(geometry
        .as_object()
        .unwrap()
        .values()
        .all(|v| v.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)));
}
