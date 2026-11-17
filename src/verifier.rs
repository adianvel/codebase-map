//! Report Verifier: validate a Report Bundle against the Report Contract.
//!
//! One interface: `verify_report(bundle, contract)`. Zero filesystem
//! dependencies: the FileSystem Adapter (the `check-report` binary) supplies
//! the bundle, and the contract assets are resolved values, so this module
//! decides only what a bundle can decide. The palette is compared against the
//! template, which is its single home; the layout numbers come from
//! docs/diagram-geometry.json, explained in docs/diagram-geometry.md; a tile's
//! technology mark is compared against docs/technology-marks.json, so a mark
//! can only be a vendored one and only where the index names that technology.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde_json::{Map, Value};

use crate::diagram::{parse_diagrams, regex, Diagram, Rect};
use crate::js;

pub const REQUIRED_FILES: [&str; 4] = [
    "index.json",
    "context.md",
    "architecture.html",
    "evidence.md",
];

const CONFIDENCE: [&str; 3] = ["confirmed", "inferred", "unknown"];
const FILE_KIND: [&str; 6] = ["source", "test", "config", "docs", "asset", "generated"];
const RELATIONSHIP_KIND: [&str; 11] = [
    "calls",
    "imports",
    "routes",
    "reads",
    "writes",
    "stores",
    "references",
    "publishes",
    "consumes",
    "renders",
    "tests",
];
const CARDINALITY: [&str; 5] = [
    "one-to-one",
    "one-to-many",
    "many-to-one",
    "many-to-many",
    "unknown",
];

// A report earns a search control once its overview stops fitting on one
// screen. SKILL.md targets 10–15 concepts for the overview; this takes the
// lower bound rather than inventing a second number.
const SEARCH_CONCEPT_THRESHOLD: usize = 10;

// context.md is the orientation layer, not the index. Keep it loadable whole.
const MAX_CONTEXT_BYTES: usize = 12 * 1024;

/// The resolved Report Contract assets. `None` means "not supplied".
#[derive(Debug, Clone, Default)]
pub struct Contract {
    pub template_html: Option<String>,
    pub marks: Option<Value>,
    pub geometry: Option<Value>,
}

impl Contract {
    /// The assets in docs/, compiled into the binary so it always checks
    /// against the contract it was built from.
    pub fn embedded() -> Self {
        Contract {
            template_html: Some(include_str!("../docs/report-template.html").to_string()),
            marks: serde_json::from_str(include_str!("../docs/technology-marks.json")).ok(),
            geometry: serde_json::from_str(include_str!("../docs/diagram-geometry.json")).ok(),
        }
    }
}

/// JavaScript truthiness, for the places the contract tests `if (value)`.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn is_blank(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

fn list(values: &[&str]) -> String {
    values.join(", ")
}

/// Validate a Report Bundle (file name to contents) and return every problem,
/// in a stable order. An empty list is a passing report.
pub fn verify_report(bundle: &Value, contract: &Contract) -> Vec<String> {
    let Some(bundle) = bundle.as_object() else {
        return vec!["report bundle must be an object".into()];
    };
    let mut errors = Vec::new();
    let file = |name: &str| bundle.get(name).filter(|v| !v.is_null());

    for name in REQUIRED_FILES {
        if file(name).is_none() {
            errors.push(format!("missing report file: {name}"));
        }
    }

    let mut index: Option<Value> = None;
    match file("index.json") {
        None => {}
        Some(Value::String(raw)) => match serde_json::from_str::<Value>(raw) {
            Ok(parsed) => index = Some(parsed),
            Err(error) => errors.push(format!("index.json is not valid JSON: {error}")),
        },
        Some(raw @ Value::Object(_)) => index = Some(raw.clone()),
        Some(_) => errors.push("index.json must be an object".into()),
    }
    let index = index.filter(truthy);

    let mut concept_ids = None;
    if let Some(index) = &index {
        match index.as_object() {
            Some(object) => concept_ids = Some(check_index(object, &mut errors)),
            None => errors.push("index.json must be an object".into()),
        }
    }

    if let Some(Value::String(html)) = file("architecture.html") {
        check_html(html, concept_ids.as_ref(), &mut errors);

        let geometry = contract.geometry.as_ref().filter(|g| truthy(g));
        if geometry.is_none() {
            errors.push(
                "diagram geometry was not supplied; layout cannot be verified against docs/diagram-geometry.json".into(),
            );
        }
        let diagrams = parse_diagrams(html, geometry.unwrap_or(&Value::Null));
        if let Some(geometry) = geometry {
            check_layout(&diagrams, geometry, &mut errors);
        }

        let marks = contract.marks.as_ref().filter(|m| !m.is_null());
        let backed = index
            .as_ref()
            .map(|index| detect_technologies(index, marks));
        check_marks(&diagrams, &mut errors, marks, backed.as_ref());

        match contract.template_html.as_deref().filter(|t| !t.is_empty()) {
            None => errors.push(
                "report template was not supplied; palette cannot be verified against docs/report-template.html".into(),
            ),
            Some(template) => check_palette(html, template, &mut errors),
        }
    }

    check_secrets(bundle, &mut errors);
    check_context_budget(bundle, &mut errors);
    errors
}

fn require_string(value: Option<&Value>, at: &str, errors: &mut Vec<String>) -> bool {
    match value {
        Some(Value::String(s)) if !is_blank(s) => true,
        _ => {
            errors.push(format!("{at} must be a non-empty string"));
            false
        }
    }
}

fn require_array<'a>(
    value: Option<&'a Value>,
    at: &str,
    errors: &mut Vec<String>,
) -> Option<&'a Vec<Value>> {
    let array = value.and_then(Value::as_array);
    if array.is_none() {
        errors.push(format!("{at} must be an array"));
    }
    array
}

fn require_one_of(value: Option<&Value>, allowed: &[&str], at: &str, errors: &mut Vec<String>) {
    if !value
        .and_then(Value::as_str)
        .is_some_and(|v| allowed.contains(&v))
    {
        errors.push(format!(
            "{at} must be one of {} (got {})",
            list(allowed),
            js::stringify(value)
        ));
    }
}

fn require_evidence_and_confidence(entry: &Value, at: &str, errors: &mut Vec<String>) {
    if let Some(evidence) = require_array(entry.get("evidence"), &format!("{at}.evidence"), errors)
    {
        if evidence.is_empty() {
            errors.push(format!(
                "{at}.evidence is empty; every material entry needs a source"
            ));
        }
        for (i, item) in evidence.iter().enumerate() {
            require_string(Some(item), &format!("{at}.evidence[{i}]"), errors);
        }
    }
    require_one_of(
        entry.get("confidence"),
        &CONFIDENCE,
        &format!("{at}.confidence"),
        errors,
    );
}

/// Schema and reference checks; returns the concept ids for the HTML checks.
// shortcut: a non-object entry (which crashed the Node check) reads as an
// entry with no fields, so it reports errors instead of aborting.
fn check_index(index: &Map<String, Value>, errors: &mut Vec<String>) -> HashSet<String> {
    let mut file_ids = HashSet::new();
    let mut concept_ids = HashSet::new();
    let field = |key: &str| index.get(key);
    let id_of = |entry: &Value| entry.get("id").and_then(Value::as_str).map(str::to_string);

    if !field("schemaVersion").is_some_and(Value::is_number) {
        errors.push("index.json is missing a numeric schemaVersion".into());
    }

    match field("repository") {
        Some(repository @ Value::Object(_)) => {
            require_string(repository.get("name"), "index.json.repository.name", errors);
        }
        _ => errors.push("index.json.repository must be an object".into()),
    }

    if let Some(files) = require_array(field("files"), "index.json.files", errors) {
        for (i, file) in files.iter().enumerate() {
            let at = format!("index.json.files[{i}]");
            if require_string(file.get("id"), &format!("{at}.id"), errors) {
                file_ids.insert(id_of(file).unwrap_or_default());
            }
            require_string(file.get("path"), &format!("{at}.path"), errors);
            require_string(file.get("summary"), &format!("{at}.summary"), errors);
            require_one_of(file.get("kind"), &FILE_KIND, &format!("{at}.kind"), errors);
            require_evidence_and_confidence(file, &at, errors);
            require_array(file.get("symbols"), &format!("{at}.symbols"), errors);
        }
    }

    let concepts = require_array(field("concepts"), "index.json.concepts", errors);
    for (i, concept) in concepts.into_iter().flatten().enumerate() {
        let at = format!("index.json.concepts[{i}]");
        if require_string(concept.get("id"), &format!("{at}.id"), errors) {
            concept_ids.insert(id_of(concept).unwrap_or_default());
        }
        require_string(concept.get("name"), &format!("{at}.name"), errors);
        require_string(concept.get("summary"), &format!("{at}.summary"), errors);
        require_evidence_and_confidence(concept, &at, errors);
    }

    let relationships = require_array(field("relationships"), "index.json.relationships", errors);
    for (i, relationship) in relationships.into_iter().flatten().enumerate() {
        let at = format!("index.json.relationships[{i}]");
        require_string(
            relationship.get("summary"),
            &format!("{at}.summary"),
            errors,
        );
        require_one_of(
            relationship.get("kind"),
            &RELATIONSHIP_KIND,
            &format!("{at}.kind"),
            errors,
        );
        if let Some(cardinality) = relationship.as_object().and_then(|r| r.get("cardinality")) {
            require_one_of(
                Some(cardinality),
                &CARDINALITY,
                &format!("{at}.cardinality"),
                errors,
            );
        }
        require_evidence_and_confidence(relationship, &at, errors);
    }

    let flows = require_array(field("flows"), "index.json.flows", errors);
    for (i, flow) in flows.into_iter().flatten().enumerate() {
        let at = format!("index.json.flows[{i}]");
        require_string(flow.get("id"), &format!("{at}.id"), errors);
        require_string(flow.get("name"), &format!("{at}.name"), errors);
        require_array(flow.get("steps"), &format!("{at}.steps"), errors);
        require_evidence_and_confidence(flow, &at, errors);
    }

    if require_array(field("gaps"), "index.json.gaps", errors).is_none() {
        return concept_ids;
    }

    // Second pass: now that every id is known, check that each reference resolves.
    let resolves = |value: Option<&Value>, ids: &HashSet<String>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|id| ids.contains(id))
    };
    for (i, relationship) in relationships.into_iter().flatten().enumerate() {
        for end in ["source", "target"] {
            let id = relationship.get(end);
            if !resolves(id, &concept_ids) {
                errors.push(format!(
                    "index.json.relationships[{i}].{end} \"{}\" is not a concept id",
                    js::string(id)
                ));
            }
        }
    }
    for (i, flow) in flows.into_iter().flatten().enumerate() {
        for (j, step) in flow
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if !resolves(Some(step), &concept_ids) {
                errors.push(format!(
                    "index.json.flows[{i}].steps[{j}] \"{}\" is not a concept id",
                    js::string(Some(step))
                ));
            }
        }
    }
    for (i, concept) in concepts.into_iter().flatten().enumerate() {
        for (j, file_id) in concept
            .get("ownerFileIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if !resolves(Some(file_id), &file_ids) {
                errors.push(format!(
                    "index.json.concepts[{i}].ownerFileIds[{j}] \"{}\" is not a file id",
                    js::string(Some(file_id))
                ));
            }
        }
    }

    concept_ids
}

fn check_html(html: &str, concept_ids: Option<&HashSet<String>>, errors: &mut Vec<String>) {
    let mut markers: Vec<&str> = Vec::new();
    for caps in regex!(r#"(?-u:\b)data-concept-id\s*=\s*"([^"]*)""#).captures_iter(html) {
        let id = caps.get(1).map_or("", |m| m.as_str());
        if !markers.contains(&id) {
            markers.push(id);
        }
    }

    if markers.is_empty() {
        errors.push(
            "architecture.html carries no data-concept-id; diagram nodes and detail entries must name their concept".into(),
        );
    }

    if let Some(concept_ids) = concept_ids {
        for id in &markers {
            if id.is_empty() {
                errors.push("architecture.html has an empty data-concept-id".into());
            } else if !concept_ids.contains(*id) {
                errors.push(format!(
                    "architecture.html references concept \"{id}\", which is not in the index"
                ));
            }
        }
        let search_control = regex!(
            r#"(?i)(?:type\s*=\s*"search"|role\s*=\s*"search"|class\s*=\s*"[^"]*search|id\s*=\s*"[^"]*search"|<input[^>]*(?-u:\b)search(?-u:\b))"#
        );
        if concept_ids.len() > SEARCH_CONCEPT_THRESHOLD && !search_control.is_match(html) {
            errors.push(format!(
                "architecture.html has {} concepts but no search control (required above {SEARCH_CONCEPT_THRESHOLD})",
                concept_ids.len()
            ));
        }
    }

    // A comment is not a control: the template's contract text names the very
    // things it forbids, so scan the markup the reader actually gets.
    let markup = regex!(r"<!--[\s\S]*?-->").replace_all(html, " ");
    let download = regex!(r"(?i)\sdownload[\s/>=]");
    let archive = regex!(r#"(?i)href\s*=\s*"[^"]*\.(?:zip|tar|tgz|gz|rar|7z)""#);
    if download.is_match(&markup) || archive.is_match(&markup) {
        errors.push("architecture.html offers a source-code download control; the report must stay read-only".into());
    }
}

/// The `:root` custom properties, lower-cased, in first-seen order.
fn palette_of(html: &str) -> Option<Vec<(String, String)>> {
    let root = regex!(r":root\s*\{([\s\S]*?)\}").captures(html)?;
    let mut vars: Vec<(String, String)> = Vec::new();
    for caps in regex!(r"(?i)(--[a-z0-9-]+)\s*:\s*([^;]+);").captures_iter(&root[1]) {
        let (name, value) = (caps[1].to_lowercase(), caps[2].trim().to_lowercase());
        match vars.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = value,
            None => vars.push((name, value)),
        }
    }
    (!vars.is_empty()).then_some(vars)
}

fn check_palette(report_html: &str, template_html: &str, errors: &mut Vec<String>) {
    let Some(expected) = palette_of(template_html) else {
        return;
    };
    let Some(actual) = palette_of(report_html) else {
        errors.push(
            "architecture.html has no :root palette to compare against the report template".into(),
        );
        return;
    };
    let actual: HashMap<_, _> = actual.into_iter().collect();
    for (name, value) in expected {
        match actual.get(&name) {
            None => errors.push(format!(
                "architecture.html is missing palette variable {name}; the template defines it as {value}"
            )),
            Some(found) if *found != value => {
                errors.push(format!("architecture.html sets {name} to {found}; the template defines {value}"))
            }
            Some(_) => {}
        }
    }
}

/// The layout numbers from docs/diagram-geometry.json.
struct Geometry {
    glyph_advance_em: f64,
    label_inset: f64,
    canvas_padding: f64,
    arrow_tolerance: f64,
}

impl Geometry {
    fn from(value: &Value) -> Self {
        let n = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        Geometry {
            glyph_advance_em: n("glyphAdvanceEm"),
            label_inset: n("labelInset"),
            canvas_padding: n("canvasPadding"),
            arrow_tolerance: n("arrowTolerance"),
        }
    }

    fn label_width(&self, chars: usize, font_size: f64) -> f64 {
        chars as f64 * self.glyph_advance_em * font_size
    }

    fn on_boundary(&self, b: &Rect, x: f64, y: f64) -> bool {
        let t = self.arrow_tolerance;
        let within = |value: f64, low: f64, high: f64| value >= low - t && value <= high + t;
        let vertical_side = (x - b.x).abs() <= t || (x - (b.x + b.width)).abs() <= t;
        let horizontal_side = (y - b.y).abs() <= t || (y - (b.y + b.height)).abs() <= t;
        (vertical_side && within(y, b.y, b.y + b.height))
            || (horizontal_side && within(x, b.x, b.x + b.width))
    }
}

fn crosses_box(x1: f64, y1: f64, x2: f64, y2: f64, b: &Rect) -> bool {
    let (left, right, top, bottom) = (x1.min(x2), x1.max(x2), y1.min(y2), y1.max(y2));
    let (box_left, box_right, box_top, box_bottom) = (b.x, b.x + b.width, b.y, b.y + b.height);
    if (y1 - y2).abs() < 0.01 {
        return y1 > box_top && y1 < box_bottom && left < box_right && right > box_left;
    }
    if (x1 - x2).abs() < 0.01 {
        return x1 > box_left && x1 < box_right && top < box_bottom && bottom > box_top;
    }
    left < box_right && right > box_left && top < box_bottom && bottom > box_top
}

#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn check_layout(diagrams: &[Diagram], geometry: &Value, errors: &mut Vec<String>) {
    let g = Geometry::from(geometry);
    let n = js::num;
    for diagram in diagrams {
        let name = &diagram.name;
        let Some(vb) = diagram.view_box else {
            errors.push(format!(
                "{name}: diagram has no parsable viewBox; the fit rules need bounds"
            ));
            continue;
        };
        // A diagram whose nodes the parser cannot see would pass every rule
        // below by accident, so say so rather than reporting a clean picture.
        if diagram.nodes.is_empty()
            && regex!(r#"class="[^"]*(?-u:\b)diagram-node(?-u:\b)"#).is_match(&diagram.raw)
        {
            errors.push(format!("{name}: diagram has diagram nodes but no <rect class=\"tile\">; the node shape in docs/diagram-geometry.md is what the fit rules measure"));
            continue;
        }

        let pad = g.canvas_padding;
        let fits = |x1: f64, x2: f64, y1: f64, y2: f64, what: &str, errors: &mut Vec<String>| {
            if x1 < vb.min_x + pad
                || x2 > vb.max_x - pad
                || y1 < vb.min_y + pad
                || y2 > vb.max_y - pad
            {
                errors.push(format!(
                    "{name}: {what} runs past the viewBox padding; every element needs {}px of margin inside 0 0 {} {}",
                    n(pad),
                    n(vb.width),
                    n(vb.height)
                ));
            }
        };

        for node in &diagram.nodes {
            let f = node.footprint;
            fits(
                f.x,
                f.x + f.width,
                f.y,
                f.y + f.height,
                &format!("node at x={} y={}", n(f.x), n(f.y)),
                errors,
            );
            for label in &node.labels {
                let budget =
                    ((f.width - g.label_inset) / (g.glyph_advance_em * label.font_size)).floor();
                if label.chars as f64 > budget {
                    errors.push(format!(
                        "{name}: node at x={} gives {} {} characters at {}px but holds {}; shorten the label or move the detail to the evidence panel",
                        n(f.x), label.kind, n(budget), n(label.font_size), label.chars
                    ));
                }
                let width = g.label_width(label.chars, label.font_size);
                let centre = f.x + f.width / 2.0;
                fits(
                    centre - width / 2.0,
                    centre + width / 2.0,
                    f.y,
                    f.y + f.height,
                    &format!("{} text", label.kind),
                    errors,
                );
            }
        }

        for (i, a) in diagram.nodes.iter().enumerate() {
            for b in &diagram.nodes[i + 1..] {
                let (a, b) = (a.footprint, b.footprint);
                if a.x < b.x + b.width
                    && b.x < a.x + a.width
                    && a.y < b.y + b.height
                    && b.y < a.y + a.height
                {
                    errors.push(format!(
                        "{name}: nodes at x={} y={} and x={} y={} overlap",
                        n(a.x),
                        n(a.y),
                        n(b.x),
                        n(b.y)
                    ));
                }
            }
        }

        for label in &diagram.labels {
            let width = g.label_width(label.chars, label.font_size);
            let (x1, x2) = match label.anchor.as_str() {
                "middle" => (label.x - width / 2.0, label.x + width / 2.0),
                "end" => (label.x - width, label.x),
                _ => (label.x, label.x + width),
            };
            fits(
                x1,
                x2,
                label.y - label.font_size,
                label.y,
                &format!("{} \"{}\"", label.kind, label.content),
                errors,
            );
            for node in &diagram.nodes {
                let f = node.footprint;
                let clears_vertically =
                    label.y <= f.y || label.y - label.font_size >= f.y + f.height;
                let clears_horizontally = x2 <= f.x || x1 >= f.x + f.width;
                if !clears_vertically && !clears_horizontally {
                    errors.push(format!(
                        "{name}: label \"{}\" sits on top of the node at x={} y={}",
                        label.content,
                        n(f.x),
                        n(f.y)
                    ));
                }
            }
        }

        if diagram.nodes.len() < 2 {
            continue;
        }

        for edge in &diagram.edges {
            let Some(segments) = edge.segments.as_ref().filter(|s| !s.is_empty()) else {
                continue;
            };
            let (start, finish) = (segments[0], segments[segments.len() - 1]);
            let has_source = diagram
                .nodes
                .iter()
                .any(|node| g.on_boundary(&node.footprint, start.x1, start.y1));
            let has_target = diagram
                .nodes
                .iter()
                .any(|node| g.on_boundary(&node.footprint, finish.x2, finish.y2));
            if !has_source || !has_target {
                let missing = match (has_source, has_target) {
                    (false, false) => "source and target",
                    (false, true) => "source",
                    _ => "target",
                };
                errors.push(format!(
                    "{name}: edge \"{}\" is not attached to a node boundary at the {missing}",
                    edge.d
                ));
            }

            for s in segments {
                let shrink = g.arrow_tolerance;
                let (dx, dy) = (s.x2 - s.x1, s.y2 - s.y1);
                // `!(a <= b)` keeps Node's NaN behaviour: a NaN length is not short.
                let inner = if s.axis == 'L' {
                    let length = dx.hypot(dy);
                    (!(length <= shrink * 2.0)).then(|| {
                        let (ux, uy) = (dx / length, dy / length);
                        (
                            s.x1 + ux * shrink,
                            s.y1 + uy * shrink,
                            s.x2 - ux * shrink,
                            s.y2 - uy * shrink,
                        )
                    })
                } else if dx.abs() < 0.01 {
                    let sign = if dy > 0.0 { 1.0 } else { -1.0 };
                    (!(dy.abs() <= shrink * 2.0)).then_some((
                        s.x1,
                        s.y1 + sign * shrink,
                        s.x2,
                        s.y2 - sign * shrink,
                    ))
                } else {
                    let sign = if dx > 0.0 { 1.0 } else { -1.0 };
                    (!(dx.abs() <= shrink * 2.0)).then_some((
                        s.x1 + sign * shrink,
                        s.y1,
                        s.x2 - sign * shrink,
                        s.y2,
                    ))
                };
                let Some((x1, y1, x2, y2)) = inner else {
                    continue;
                };
                for node in &diagram.nodes {
                    let f = node.footprint;
                    if crosses_box(x1, y1, x2, y2, &f) {
                        errors.push(format!(
                            "{name}: edge \"{}\" runs through the node at x={} y={}; connect footprint boundaries, never across a node",
                            edge.d, n(f.x), n(f.y)
                        ));
                    }
                }
            }
        }
    }
}

/// Every string the index states, lower-cased: the text a mark has to earn
/// its place in. Paths, names, summaries, evidence, and gaps all count.
fn index_text(index: &Value) -> String {
    fn walk<'a>(value: &'a Value, parts: &mut Vec<&'a str>) {
        match value {
            Value::String(s) => parts.push(s),
            Value::Array(items) => items.iter().for_each(|v| walk(v, parts)),
            Value::Object(map) => map.values().for_each(|v| walk(v, parts)),
            _ => {}
        }
    }
    let mut parts = Vec::new();
    walk(index, &mut parts);
    parts.join("\n").to_lowercase()
}

/// "react" backs React; "reactive" does not. Keywords that end in a separator
/// (".github/workflows", "node.js") match on their own.
fn names_token(text: &str, token: &str) -> bool {
    let (text, token) = (text.as_bytes(), token.as_bytes());
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    // `..=` so an empty keyword can match at the very end (Node looped forever on one).
    (0..=text.len())
        .filter(|&at| text[at..].starts_with(token))
        .any(|at| {
            let before = if at == 0 { None } else { text.get(at - 1) };
            !word(before) && !word(text.get(at + token.len()))
        })
}

fn detect_technologies(index: &Value, marks: Option<&Value>) -> HashSet<String> {
    let Some(list) = marks
        .and_then(|m| m.get("marks"))
        .filter(|m| truthy(m))
        .and_then(Value::as_array)
    else {
        return HashSet::new();
    };
    let text = index_text(index);
    list.iter()
        .filter(|mark| {
            mark.get("keywords")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|token| names_token(&text, &js::string(Some(token)).to_lowercase()))
        })
        .map(|mark| js::string(mark.get("slug")))
        .collect()
}

fn normalized_path(d: &str) -> String {
    regex!(r"\s+").replace_all(d, " ").trim().to_string()
}

/// A mark is borrowed identity, so it is checked several ways: it must be a
/// real slug, drawn from the vendored path, in the ink the template sets,
/// placed inside its tile, and (the rule that keeps the map honest) named by
/// the index rather than assumed from how the repository looks.
fn check_marks(
    diagrams: &[Diagram],
    errors: &mut Vec<String>,
    marks: Option<&Value>,
    backed: Option<&HashSet<String>>,
) {
    let by_slug: Option<HashMap<String, &Value>> = marks
        .filter(|m| truthy(m))
        .and_then(|m| m.get("marks"))
        .filter(|m| truthy(m))
        .map(|list| {
            list.as_array()
                .into_iter()
                .flatten()
                .map(|m| (js::string(m.get("slug")), m))
                .collect()
        });
    let box_size = marks
        .and_then(|m| m.get("box"))
        .filter(|b| truthy(b))
        .and_then(Value::as_f64)
        .unwrap_or(24.0);
    let n = js::num;

    for diagram in diagrams {
        let name = &diagram.name;
        for node in &diagram.nodes {
            let tile = node.tile;
            let Some(logo) = &node.logo else {
                if !node.kind_code {
                    errors.push(format!(
                        "{name}: the tile at x={} y={} carries neither a technology mark nor a kind code",
                        n(tile.x), n(tile.y)
                    ));
                }
                continue;
            };

            if node.kind_code {
                errors.push(format!(
                    "{name}: the tile at x={} y={} carries both a technology mark and a kind code; a tile shows one",
                    n(tile.x), n(tile.y)
                ));
            }

            let Some(slug) = logo.slug.as_deref().filter(|s| !s.is_empty()) else {
                errors.push(format!("{name}: a tile-logo has no data-tech; the check cannot tell which technology it claims"));
                continue;
            };

            let Some(by_slug) = &by_slug else {
                errors.push(format!("{name}: report draws the \"{slug}\" mark but docs/technology-marks.json was not read; the path cannot be verified"));
                continue;
            };

            let Some(mark) = by_slug.get(slug) else {
                errors.push(format!("{name}: \"{slug}\" is not a mark in docs/technology-marks.json; use a vendored slug or the kind code"));
                continue;
            };

            if logo.has_colour {
                errors.push(format!("{name}: the \"{slug}\" mark carries its own colour; the template sets one ink for every mark and a brand path is never recoloured"));
            }

            match logo.path.as_deref().filter(|p| !p.is_empty()) {
                None => errors.push(format!("{name}: the \"{slug}\" mark has no <path d>; copy the vendored path into it")),
                Some(path) if normalized_path(path) != normalized_path(&js::string(mark.get("path"))) => errors.push(format!(
                    "{name}: the \"{slug}\" mark is not the path in docs/technology-marks.json; copy it verbatim or drop the mark"
                )),
                Some(_) => {}
            }

            if backed.is_some_and(|backed| !backed.contains(slug)) {
                errors.push(format!("{name}: the \"{slug}\" mark is not backed by index.json; name the technology in the evidence or use the kind code"));
            }

            match logo.placed {
                None => errors.push(format!(
                    "{name}: the \"{slug}\" mark needs a transform that places its {b}x{b} path inside the tile; docs/diagram-geometry.md gives translate and scale",
                    b = n(box_size)
                )),
                Some(placed) => {
                    let size = box_size * placed.scale;
                    let inside = placed.x >= tile.x
                        && placed.y >= tile.y
                        && placed.x + size <= tile.x + tile.width
                        && placed.y + size <= tile.y + tile.height;
                    if !inside {
                        errors.push(format!(
                            "{name}: the \"{slug}\" mark covers x={} y={} {s}x{s}, which is not inside its tile at x={} y={} {}x{}",
                            n(placed.x), n(placed.y), n(tile.x), n(tile.y), n(tile.width), n(tile.height), s = n(size)
                        ));
                    }
                }
            }
        }
    }
}

const SECRET_PATTERNS: [(&str, &str); 5] = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key block"),
    (r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)", "AWS access key id"),
    (
        r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{20,}(?-u:\b)",
        "GitHub token",
    ),
    (
        r"(?-u:\b)xox[baprs]-[A-Za-z0-9-]{10,}(?-u:\b)",
        "Slack token",
    ),
    (r"(?-u:\b)sk-[A-Za-z0-9]{20,}(?-u:\b)", "API key"),
];

// High-signal shapes only. The bare word "secret" is not evidence of a leak.
fn check_secrets(bundle: &Map<String, Value>, errors: &mut Vec<String>) {
    static PATTERNS: std::sync::OnceLock<Vec<(Regex, &str)>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        SECRET_PATTERNS
            .iter()
            .map(|(p, label)| (Regex::new(p).expect("valid regex"), *label))
            .collect()
    });
    for name in REQUIRED_FILES {
        let Some(Value::String(contents)) = bundle.get(name) else {
            continue;
        };
        for (pattern, label) in patterns {
            if pattern.is_match(contents) {
                errors.push(format!("{name} looks like it contains a {label}"));
            }
        }
    }
}

fn check_context_budget(bundle: &Map<String, Value>, errors: &mut Vec<String>) {
    let size = match bundle.get("context.md") {
        None | Some(Value::Null) => return,
        Some(Value::String(content)) => content.len(),
        Some(_) => 0,
    };
    if size > MAX_CONTEXT_BYTES {
        errors.push(format!("context.md is {size} bytes; the budget is {MAX_CONTEXT_BYTES} so it stays loadable whole"));
    }
}
