//! Outside judge for Report Verifier speed.
//!
//!   cargo bench --bench verify_report
//!   cargo bench --bench verify_report -- --profile-time 5
//!
//! Phase means (json, parse, html, layout, marks) are printed by
//! `cargo test --release --test speed -- phase_split --nocapture`.

use std::hint::black_box;

use codebase_map::{verify_report, Contract, REQUIRED_FILES};
use criterion::{criterion_group, criterion_main, Criterion};
use pprof::criterion::{Output, PProfProfiler};
use serde_json::{json, Value};

const EXAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/examples/tiny-app/reports/codebase-map/tiny-app"
);

fn example_bundle() -> Value {
    let mut bundle = serde_json::Map::new();
    for name in REQUIRED_FILES {
        let text = std::fs::read_to_string(format!("{EXAMPLE}/{name}")).unwrap();
        bundle.insert(name.to_string(), Value::String(text));
    }
    Value::Object(bundle)
}

/// A passing 200-node map: tiles on a 40-column grid, short labels, kind
/// codes, and one horizontal edge between neighbours. Layout, palette, and
/// technology backing all run.
fn big_bundle(nodes: usize) -> Value {
    let example_html = std::fs::read_to_string(format!("{EXAMPLE}/architecture.html")).unwrap();
    let style_end = example_html.find("</style>").unwrap() + "</style>".len();
    let style = &example_html[..style_end];
    let mut svg =
        String::from(r#"<svg class="diagram" viewBox="0 0 8400 1400"><title>Big map</title>"#);
    let cols = 40;
    for i in 0..nodes {
        let col = i % cols;
        let row = i / cols;
        let x = 80 + col * 200;
        let y = 80 + row * 180;
        if col + 1 < cols && i + 1 < nodes {
            let x1 = x + 96;
            let x2 = x + 164;
            let ey = y + 30;
            svg.push_str(&format!(
                r#"<path class="edge-muted" d="M{x1} {ey} H{x2}"></path><text class="edge-label" x="{lx}" y="{ly}">go</text>"#,
                lx = x1 + 20,
                ly = ey - 12,
            ));
        }
        svg.push_str(&format!(
            r#"<a class="diagram-node" data-concept-id="c{i}"><rect class="tile" x="{x}" y="{y}" width="60" height="60" rx="12"></rect><text class="tile-mark" x="{cx}" y="{my}">FN</text><text class="node-title" x="{cx}" y="{ty}" text-anchor="middle">Node {i}</text><text class="node-subtitle" x="{cx}" y="{sy}" text-anchor="middle">n{i}.rs</text></a>"#,
            cx = x + 30,
            my = y + 36,
            ty = y + 78,
            sy = y + 96,
        ));
    }
    svg.push_str("</svg>");
    let html = format!("{style}\n<input type=\"search\" aria-label=\"search\">\n{svg}");
    let mut concepts = Vec::new();
    let mut files = Vec::new();
    for i in 0..nodes {
        concepts.push(json!({
            "id": format!("c{i}"),
            "name": format!("Node {i}"),
            "summary": format!("Concept {i} in the generated map"),
            "evidence": [format!("src/n{i}.rs:1")],
            "confidence": "confirmed",
            "ownerFileIds": [format!("f{i}")]
        }));
        files.push(json!({
            "id": format!("f{i}"),
            "path": format!("src/n{i}.rs"),
            "summary": format!("File {i}"),
            "kind": "source",
            "evidence": [format!("src/n{i}.rs:1")],
            "confidence": "confirmed",
            "symbols": [format!("c{i}")]
        }));
    }
    let index = json!({
        "schemaVersion": 1,
        "repository": {"name": "big"},
        "files": files,
        "concepts": concepts,
        "relationships": [],
        "flows": [],
        "gaps": []
    });
    json!({
        "index.json": index.to_string(),
        "context.md": "orientation",
        "architecture.html": html,
        "evidence.md": "evidence"
    })
}

fn verify(c: &mut Criterion) {
    let contract = Contract::embedded();
    let example = example_bundle();
    let big = big_bundle(200);
    let big_errors = verify_report(&big, &contract);
    assert!(
        big_errors.is_empty(),
        "200-node fixture must pass, got {big_errors:?}"
    );

    c.bench_function("verify_report/example", |b| {
        b.iter(|| black_box(verify_report(black_box(&example), black_box(&contract))))
    });
    c.bench_function("verify_report/200-nodes", |b| {
        b.iter(|| black_box(verify_report(black_box(&big), black_box(&contract))))
    });
}

criterion_group! {
    name = benches;
    config = Criterion::default().with_profiler(PProfProfiler::new(5000, Output::Flamegraph(None)));
    targets = verify
}
criterion_main!(benches);
