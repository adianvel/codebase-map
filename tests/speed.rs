//! Release-mode tripwire for the 200-node Report Verifier.
//! Debug builds return immediately. CI runs `cargo test --release --test speed`.

use std::hint::black_box;
use std::time::Instant;

use codebase_map::{verify_report, verify_report_phases, Contract, PhaseNanos, REQUIRED_FILES};
use serde_json::{json, Value};

const EXAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/examples/tiny-app/reports/codebase-map/tiny-app"
);

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

#[test]
fn release_200_node_map_stays_under_three_milliseconds() {
    if cfg!(debug_assertions) {
        return;
    }
    let contract = Contract::embedded();
    let big = big_bundle(200);
    let errors = verify_report(&big, &contract);
    assert!(errors.is_empty(), "{errors:?}");
    for _ in 0..5 {
        black_box(verify_report(black_box(&big), black_box(&contract)));
    }
    let iters = 40;
    let start = Instant::now();
    for _ in 0..iters {
        black_box(verify_report(black_box(&big), black_box(&contract)));
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    eprintln!("speed 200-node mean {ms:.3} ms");
    assert!(
        ms < 3.0,
        "200-node verify_report averaged {ms:.3} ms, regression guard is 3 ms"
    );
}

#[test]
fn release_200_node_phase_split() {
    if cfg!(debug_assertions) {
        return;
    }
    let contract = Contract::embedded();
    let big = big_bundle(200);
    for _ in 0..3 {
        black_box(verify_report_phases(black_box(&big), black_box(&contract)));
    }
    let iters = 30u32;
    let mut acc = PhaseNanos::default();
    for _ in 0..iters {
        let (errors, phases) = verify_report_phases(black_box(&big), black_box(&contract));
        assert!(errors.is_empty(), "{errors:?}");
        acc += phases;
    }
    let ms = |n: u64| n as f64 / 1e6 / f64::from(iters);
    eprintln!(
        "phases json={:.3} index={:.3} html={:.3} parse={:.3} layout={:.3} marks={:.3} palette={:.3} rest={:.3} total={:.3}",
        ms(acc.json),
        ms(acc.index),
        ms(acc.html),
        ms(acc.parse),
        ms(acc.layout),
        ms(acc.marks),
        ms(acc.palette),
        ms(acc.rest),
        ms(acc.total())
    );
    assert!(acc.parse > 0 && acc.json > 0 && acc.html > 0);
}

#[test]
fn example_files_are_present() {
    for name in REQUIRED_FILES {
        assert!(std::path::Path::new(EXAMPLE).join(name).is_file());
    }
}
