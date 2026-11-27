//! Diagram Model extraction.
//!
//! One interface: `parse_diagrams(html, geometry)`. Everything the Report
//! Verifier needs to know about a drawn diagram (viewBox, nodes with
//! footprints and technology marks, segmented edges, and labels) is extracted
//! here, so the geometry and mark checks consume the model and never the raw
//! markup. The footprint dimensions come from the supplied geometry
//! (docs/diagram-geometry.json); without them a node falls back to its tile.

use serde_json::Value;

fn find_needle(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    let mut i = 0;
    let last = h.len() - n.len();
    while let Some(rel) = memchr::memchr(n[0], &h[i..=last]) {
        let at = i + rel;
        if &h[at..at + n.len()] == n {
            return Some(at);
        }
        i = at + 1;
        if i > last {
            break;
        }
    }
    None
}

use crate::js;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ViewBox {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub width: f64,
    pub height: f64,
}

/// A node's own label: `kind` is `title` or `subtitle`, `chars` its length.
#[derive(Debug, Clone)]
pub struct NodeLabel {
    pub kind: String,
    pub chars: usize,
    pub font_size: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Debug, Clone)]
pub struct Logo {
    pub slug: Option<String>,
    pub has_colour: bool,
    pub path: Option<String>,
    pub placed: Option<Placement>,
}

/// A tile plus the labels centred under it. `footprint` is what edges attach
/// to and what must not overlap; `tile` is the drawn square.
#[derive(Debug, Clone)]
pub struct Node {
    pub footprint: Rect,
    pub tile: Rect,
    pub labels: Vec<NodeLabel>,
    pub logo: Option<Logo>,
    pub kind_code: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Segment {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub axis: char,
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub d: String,
    pub segments: Option<Vec<Segment>>,
}

/// An edge or boundary label; `chars` is the decoded length.
#[derive(Debug, Clone)]
pub struct Label {
    pub content: String,
    pub chars: usize,
    pub font_size: f64,
    pub x: f64,
    pub y: f64,
    pub anchor: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct Diagram {
    pub view_box: Option<ViewBox>,
    pub name: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub labels: Vec<Label>,
    pub raw: String,
}

macro_rules! regex {
    ($pattern:expr) => {{
        static RE: ::std::sync::OnceLock<::regex::Regex> = ::std::sync::OnceLock::new();
        RE.get_or_init(|| ::regex::Regex::new($pattern).expect("valid regex"))
    }};
}
pub(crate) use regex;

/// JavaScript strings measure UTF-16 code units; label budgets do too.
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `(?-u:\b){name}\s*=\s*"([^"]*)"`, first match. A byte scan: the regex
/// engine's backtracker was the hot path on a large diagram.
fn attribute<'a>(el: &'a str, name: &str) -> Option<&'a str> {
    if name.is_empty() {
        return None;
    }
    let starts_word = name.chars().next().is_some_and(ascii_word);
    let mut rest = el;
    while let Some(at) = find_needle(rest, name) {
        let boundary = match rest[..at].chars().next_back() {
            None => starts_word,
            Some(c) => ascii_word(c) != starts_word,
        };
        if boundary {
            let after = rest[at + name.len()..].trim_start_matches(char::is_whitespace);
            if let Some(after) = after.strip_prefix('=') {
                let after = after.trim_start_matches(char::is_whitespace);
                if let Some(value) = after.strip_prefix('"') {
                    if let Some(end) = value.find('"') {
                        return Some(&value[..end]);
                    }
                }
            }
        }
        let step = rest[at..].chars().next().map_or(1, char::len_utf8);
        rest = &rest[at + step..];
    }
    None
}

/// `(?-u:\b)word(?-u:\b)` inside `hay`.
fn has_ascii_word(hay: &str, word: &str) -> bool {
    let bytes = hay.as_bytes();
    let needle = word.as_bytes();
    if needle.is_empty() || !ascii_word(word.chars().next().unwrap()) {
        return false;
    }
    let mut from = 0;
    while let Some(rel) = find_needle(&hay[from..], word) {
        let at = from + rel;
        let before = at == 0 || !ascii_word(bytes[at - 1] as char);
        let after_i = at + needle.len();
        let after = after_i >= bytes.len() || !ascii_word(bytes[after_i] as char);
        if before && after {
            return true;
        }
        from = at + 1;
        while from < hay.len() && !hay.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

fn class_of(tag: &str) -> Option<&str> {
    attribute(tag, "class")
}

/// `<name` with an ASCII word boundary after the name, then the element
/// through `end_tag` (inclusive). Non-greedy, same as `[\s\S]*?`.
fn elements<'a>(html: &'a str, open: &str, end_tag: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = find_needle(&html[from..], open) {
        let at = from + rel;
        let after = at + open.len();
        let boundary = after >= html.len() || !ascii_word(html.as_bytes()[after] as char);
        if !boundary {
            from = at + 1;
            continue;
        }
        let Some(end_rel) = find_needle(&html[after..], end_tag) else {
            break;
        };
        let end = after + end_rel + end_tag.len();
        out.push(&html[at..end]);
        from = end;
    }
    out
}

fn number_attribute(el: &str, name: &str) -> f64 {
    let value = attribute(el, name).map_or(f64::NAN, js::parse_float);
    if value.is_finite() {
        value
    } else {
        f64::NAN
    }
}

fn transform_of(el: &str) -> Option<Placement> {
    let raw = attribute(el, "transform").filter(|raw| !raw.is_empty())?;
    let r#move = regex!(r"translate\(\s*(-?[0-9.]+)[ ,]+(-?[0-9.]+)\s*\)").captures(raw)?;
    let zoom = regex!(r"scale\(\s*(-?[0-9.]+)\s*\)").captures(raw)?;
    Some(Placement {
        x: js::parse_float(&r#move[1]),
        y: js::parse_float(&r#move[2]),
        scale: js::parse_float(&zoom[1]),
    })
}

fn decoded_text(raw: &str) -> String {
    if !raw.as_bytes().contains(&b'&') {
        return raw.to_string();
    }
    regex!(r"&(?:[a-z]+|#[0-9]+|#[xX][0-9a-fA-F]+);")
        .replace_all(raw, "x")
        .into_owned()
}

/// Font sizes stated once in the report CSS. A label whose size the report does
/// not state is a label the budget cannot be decided for, so it is skipped.
struct StatedFontSizes {
    node_title: Option<f64>,
    node_subtitle: Option<f64>,
    edge_label: Option<f64>,
    boundary_label: Option<f64>,
}

impl StatedFontSizes {
    fn read(html: &str) -> Self {
        let px = |re: &regex::Regex| re.captures(html).map(|c| js::parse_float(&c[1]));
        Self {
            node_title: px(regex!(r"\.node-title\s*\{[^}]*font-size\s*:\s*([0-9.]+)px")),
            node_subtitle: px(regex!(
                r"\.node-subtitle\s*\{[^}]*font-size\s*:\s*([0-9.]+)px"
            )),
            edge_label: px(regex!(r"\.edge-label\s*\{[^}]*font-size\s*:\s*([0-9.]+)px")),
            boundary_label: px(regex!(
                r"\.boundary-label\s*\{[^}]*font-size\s*:\s*([0-9.]+)px"
            )),
        }
    }

    fn for_class(&self, class_name: &str) -> Option<f64> {
        match class_name {
            "node-title" => self.node_title,
            "node-subtitle" => self.node_subtitle,
            "edge-label" => self.edge_label,
            "boundary-label" => self.boundary_label,
            _ => None,
        }
    }
}

fn view_box_of(svg: &str) -> Option<ViewBox> {
    let raw = attribute(svg, "viewBox").filter(|raw| !raw.is_empty())?;
    let parts: Vec<f64> = regex!(r"[\s,]+")
        .split(raw.trim())
        .map(js::number)
        .collect();
    if parts.len() != 4 || parts.iter().any(|n| !n.is_finite()) {
        return None;
    }
    let (min_x, min_y, width, height) = (parts[0], parts[1], parts[2], parts[3]);
    Some(ViewBox {
        min_x,
        min_y,
        max_x: min_x + width,
        max_y: min_y + height,
        width,
        height,
    })
}

fn path_command(b: u8) -> bool {
    matches!(
        b,
        b'M' | b'L' | b'H' | b'V' | b'Z' | b'm' | b'l' | b'h' | b'v' | b'z'
    )
}

fn segments_of(d: &str) -> Option<Vec<Segment>> {
    let bytes = d.as_bytes();
    let mut i = 0;
    let mut saw = false;
    let (mut cursor_x, mut cursor_y) = (0.0, 0.0);
    let mut segments = Vec::new();
    while i < bytes.len() {
        if !path_command(bytes[i]) {
            i += 1;
            continue;
        }
        saw = true;
        let command = bytes[i] as char;
        i += 1;
        if command.is_ascii_lowercase() {
            return None;
        }
        if command == 'Z' {
            continue;
        }
        let mut args = Vec::new();
        while i < bytes.len() && !path_command(bytes[i]) {
            if bytes[i] == b'-' || bytes[i].is_ascii_digit() || bytes[i] == b'.' {
                let start = i;
                if bytes[i] == b'-' {
                    i += 1;
                }
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'.' {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i > start {
                    args.push(js::number(&d[start..i]));
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        let arg = |k: usize| args.get(k).copied().unwrap_or(f64::NAN);
        if args.is_empty() {
            return None;
        }
        let (x, y) = match command {
            'M' | 'L' => (arg(0), arg(1)),
            'H' => (arg(0), cursor_y),
            _ => (cursor_x, arg(0)),
        };
        // A moveto opens a subpath; it is not a drawn segment, so it cannot
        // attach to or cross anything.
        if command != 'M' {
            segments.push(Segment {
                x1: cursor_x,
                y1: cursor_y,
                x2: x,
                y2: y,
                axis: command,
            });
        }
        cursor_x = x;
        cursor_y = y;
    }
    if !saw {
        return None;
    }
    Some(segments)
}

fn box_of(rect: &str) -> Rect {
    Rect {
        x: number_attribute(rect, "x"),
        y: number_attribute(rect, "y"),
        width: number_attribute(rect, "width"),
        height: number_attribute(rect, "height"),
    }
}

/// `geometry.key ?? fallback`, as a number.
fn dimension(geometry: &Value, key: &str, fallback: f64) -> f64 {
    match geometry.get(key) {
        None | Some(Value::Null) => fallback,
        Some(value) => value.as_f64().unwrap_or(f64::NAN),
    }
}

fn element_inner(el: &str) -> &str {
    let start = el.find('>').map_or(0, |i| i + 1);
    let end = el.rfind('<').unwrap_or(el.len());
    if end > start {
        &el[start..end]
    } else {
        ""
    }
}

fn opening_tag(el: &str) -> &str {
    let end = el.find('>').unwrap_or(el.len());
    &el[..end]
}

fn earlier_word<'a>(class: &'a str, words: &[&'a str]) -> Option<&'a str> {
    words
        .iter()
        .filter_map(|word| {
            class
                .match_indices(word)
                .find(|(at, _)| {
                    let bytes = class.as_bytes();
                    let before = *at == 0 || !ascii_word(bytes[*at - 1] as char);
                    let after = *at + word.len();
                    let after_ok = after >= bytes.len() || !ascii_word(bytes[after] as char);
                    before && after_ok
                })
                .map(|(at, _)| (at, *word))
        })
        .min_by_key(|(at, _)| *at)
        .map(|(_, word)| word)
}

fn has_edge_class(class: &str) -> bool {
    let bytes = class.as_bytes();
    let mut from = 0;
    while let Some(rel) = find_needle(&class[from..], "edge-") {
        let at = from + rel;
        if at == 0 || !ascii_word(bytes[at - 1] as char) {
            return true;
        }
        from = at + 1;
    }
    false
}

fn has_paint_attr(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        for name in ["fill", "stroke", "color", "style"] {
            let n = name.len();
            if i + n <= bytes.len() && bytes[i..i + n].eq_ignore_ascii_case(name.as_bytes()) {
                let before = i == 0 || !ascii_word(bytes[i - 1] as char);
                let after = i + n;
                let after_ok = after >= bytes.len() || !ascii_word(bytes[after] as char);
                if before && after_ok {
                    let rest = raw[after..].trim_start_matches(char::is_whitespace);
                    if rest.starts_with('=') {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

fn parse_diagram(svg: &str, fonts: &StatedFontSizes, geometry: &Value) -> Diagram {
    let view_box = view_box_of(svg);
    let title = elements(svg, "<title", "</title>")
        .into_iter()
        .next()
        .map(element_inner);
    let mut nodes = Vec::new();
    for block in elements(svg, "<a", "</a>") {
        let Some(rect) = elements(block, "<rect", ">").into_iter().find(|tag| {
            class_of(opening_tag(tag)).is_some_and(|class| has_ascii_word(class, "tile"))
        }) else {
            continue;
        };
        let tile = box_of(rect);
        let centre = tile.x + tile.width / 2.0;
        let width = dimension(geometry, "footprintWidth", tile.width);
        let height = dimension(geometry, "footprintHeight", tile.height);
        let footprint = Rect {
            x: centre - width / 2.0,
            y: tile.y,
            width,
            height,
        };

        let mut labels = Vec::new();
        for el in elements(block, "<text", "</text>") {
            let tag = opening_tag(el);
            let Some(class) = class_of(tag) else { continue };
            let Some(kind_word) = earlier_word(class, &["node-title", "node-subtitle"]) else {
                continue;
            };
            let class_name = kind_word;
            let kind = if kind_word == "node-title" {
                "title"
            } else {
                "subtitle"
            };
            let Some(font_size) = fonts.for_class(class_name) else {
                continue;
            };
            labels.push(NodeLabel {
                kind: kind.to_string(),
                chars: js_len(&decoded_text(element_inner(el))),
                font_size,
            });
        }

        let logo = elements(block, "<g", "</g>")
            .into_iter()
            .find(|el| {
                class_of(opening_tag(el)).is_some_and(|class| has_ascii_word(class, "tile-logo"))
            })
            .map(|raw| {
                let group = opening_tag(raw);
                let path = elements(raw, "<path", ">").into_iter().find_map(|tag| {
                    attribute(tag, "d")
                        .filter(|d| !d.is_empty())
                        .map(str::to_string)
                });
                Logo {
                    slug: attribute(group, "data-tech").map(str::to_string),
                    has_colour: has_paint_attr(raw),
                    path,
                    placed: transform_of(group),
                }
            });
        let kind_code = elements(block, "<text", "</text>")
            .iter()
            .chain(std::iter::once(&block))
            .any(|el| {
                class_of(opening_tag(el)).is_some_and(|class| has_ascii_word(class, "tile-mark"))
                    || el.match_indices("class=\"").any(|(i, _)| {
                        let value = &el[i + 7..];
                        let value = &value[..value.find('"').unwrap_or(value.len())];
                        has_ascii_word(value, "tile-mark")
                    })
            });
        nodes.push(Node {
            footprint,
            tile,
            labels,
            logo,
            kind_code,
        });
    }

    let mut edges = Vec::new();
    for found in elements(svg, "<path", ">") {
        if !class_of(opening_tag(found)).is_some_and(has_edge_class) {
            continue;
        }
        let Some(d) = attribute(found, "d").filter(|d| !d.is_empty()) else {
            continue;
        };
        let segments = segments_of(d);
        edges.push(Edge {
            d: d.to_string(),
            segments,
        });
    }

    let mut labels = Vec::new();
    for el in elements(svg, "<text", "</text>") {
        let tag = opening_tag(el);
        let Some(class) = class_of(tag) else { continue };
        let Some(kind) = earlier_word(class, &["edge-label", "boundary-label"]) else {
            continue;
        };
        let Some(font_size) = fonts.for_class(kind) else {
            continue;
        };
        let content = decoded_text(element_inner(el));
        labels.push(Label {
            chars: js_len(&content),
            content,
            font_size,
            x: number_attribute(tag, "x"),
            y: number_attribute(tag, "y"),
            anchor: attribute(tag, "text-anchor")
                .filter(|a| !a.is_empty())
                .unwrap_or("start")
                .to_string(),
            kind: kind.to_string(),
        });
    }

    let name = title.map_or_else(|| "diagram".into(), |c| c.trim().to_string());
    Diagram {
        view_box,
        name,
        nodes,
        edges,
        labels,
        raw: svg.to_string(),
    }
}

/// Every `<svg>` in the report except icon sprites, in document order.
pub fn parse_diagrams(html: &str, geometry: &Value) -> Vec<Diagram> {
    let fonts = StatedFontSizes::read(html);
    svg_blocks(html)
        .into_iter()
        .map(|svg| parse_diagram(svg, &fonts, geometry))
        .collect()
}

/// The Node regex `/<svg\b(?![^>]*class="[^"]*icon)[^>]*>[\s\S]*?<\/svg>/g`,
/// written out because the regex crate has no lookahead.
fn svg_blocks(html: &str) -> Vec<&str> {
    let bytes = html.as_bytes();
    let mut blocks = Vec::new();
    let mut from = 0;
    while let Some(offset) = html[from..].find("<svg") {
        let start = from + offset;
        let after = start + 4;
        from = start + 1;
        if bytes
            .get(after)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            continue;
        }
        let tag_end = html[after..].find('>').map(|i| after + i);
        let prefix = &html[after..tag_end.unwrap_or(html.len())];
        let is_icon = prefix.match_indices("class=\"").any(|(i, _)| {
            let value = &html[after + i + 7..];
            value[..value.find('"').unwrap_or(value.len())].contains("icon")
        });
        let Some(tag_end) = tag_end else { continue };
        if is_icon {
            continue;
        }
        let Some(close) = html[tag_end + 1..].find("</svg>") else {
            continue;
        };
        let end = tag_end + 1 + close + "</svg>".len();
        blocks.push(&html[start..end]);
        from = end;
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn geometry() -> Value {
        json!({"footprintWidth": 132, "footprintHeight": 100})
    }

    #[test]
    fn a_node_is_its_footprint_around_the_tile() {
        let html = r#"<style>.node-title { font-size: 13px; }</style><svg viewBox="0 0 400 200"><title> View </title>
            <a data-concept-id="a"><rect class="tile" x="90" y="40" width="60" height="60"></rect>
            <text class="tile-mark">FN</text><text class="node-title">A &amp; B</text></a></svg>"#;
        let diagrams = parse_diagrams(html, &geometry());
        assert_eq!(diagrams.len(), 1);
        let d = &diagrams[0];
        assert_eq!(d.name, "View");
        assert_eq!(d.view_box.unwrap().max_x, 400.0);
        let n = &d.nodes[0];
        assert_eq!(
            n.tile,
            Rect {
                x: 90.0,
                y: 40.0,
                width: 60.0,
                height: 60.0
            }
        );
        assert_eq!(
            n.footprint,
            Rect {
                x: 54.0,
                y: 40.0,
                width: 132.0,
                height: 100.0
            }
        );
        assert!(n.kind_code && n.logo.is_none());
        assert_eq!(
            (
                n.labels[0].kind.as_str(),
                n.labels[0].chars,
                n.labels[0].font_size
            ),
            ("title", 5, 13.0)
        );
    }

    #[test]
    fn without_geometry_the_footprint_is_the_tile() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" x="1" y="2" width="3" height="4"/></a></svg>"#;
        let node = &parse_diagrams(html, &Value::Null)[0].nodes[0];
        assert_eq!(node.footprint, node.tile);
    }

    #[test]
    fn icon_sprites_are_not_diagrams() {
        let html = r#"<svg class="icon x"><path/></svg><svg class="diagram" viewBox="0 0 1 1"></svg><svgx></svgx>"#;
        let diagrams = parse_diagrams(html, &geometry());
        assert_eq!(diagrams.len(), 1);
        assert_eq!(
            diagrams[0].raw,
            r#"<svg class="diagram" viewBox="0 0 1 1"></svg>"#
        );
    }

    #[test]
    fn edges_become_absolute_segments() {
        let segments = segments_of("M186 120 H234 V300 L10 20 Z").unwrap();
        let ends: Vec<_> = segments.iter().map(|s| (s.axis, s.x2, s.y2)).collect();
        assert_eq!(
            ends,
            vec![('H', 234.0, 120.0), ('V', 234.0, 300.0), ('L', 10.0, 20.0)]
        );
        assert!(segments_of("m1 1 l2 2").is_none());
        assert!(segments_of("no commands").is_none());
    }

    #[test]
    fn tile_x_is_not_taken_from_a_longer_attribute() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" rx="12" x="90" y="2" width="3" height="4"/></a></svg>"#;
        let tile = &parse_diagrams(html, &Value::Null)[0].nodes[0].tile;
        assert_eq!((tile.x, tile.y, tile.width), (90.0, 2.0, 3.0));
    }

    #[test]
    fn the_first_word_bounded_attribute_wins() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" data-x="1" x="90" y="2" width="3" height="4"/></a></svg>"#;
        let tile = &parse_diagrams(html, &Value::Null)[0].nodes[0].tile;
        assert_eq!(tile.x, 1.0);
    }

    #[test]
    fn attributes_allow_whitespace_around_equals() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" x = "15" y="2" width="3" height="4"/></a></svg>"#;
        let tile = &parse_diagrams(html, &Value::Null)[0].nodes[0].tile;
        assert_eq!(tile.x, 15.0);
    }

    #[test]
    fn a_single_quoted_attribute_is_not_a_value() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" x='15' y="2" width="3" height="4"/></a></svg>"#;
        let tile = &parse_diagrams(html, &Value::Null)[0].nodes[0].tile;
        assert!(tile.x.is_nan());
        assert_eq!(tile.y, 2.0);
    }

    #[test]
    fn an_underscore_glues_the_attribute_name() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" _x="3" x="90" y="2" width="3" height="4"/></a></svg>"#;
        let tile = &parse_diagrams(html, &Value::Null)[0].nodes[0].tile;
        assert_eq!(tile.x, 90.0);
    }

    #[test]
    fn a_logo_carries_slug_path_colour_and_placement() {
        let html = r#"<svg viewBox="0 0 9 9"><a><rect class="tile" x="0" y="0" width="60" height="60"/>
            <g class="tile-logo" data-tech="react" transform="translate(18, 18) scale(1)"><path d="M1 1"/></g></a></svg>"#;
        let logo = parse_diagrams(html, &geometry())[0].nodes[0]
            .logo
            .clone()
            .unwrap();
        assert_eq!(logo.slug.as_deref(), Some("react"));
        assert_eq!(logo.path.as_deref(), Some("M1 1"));
        assert!(!logo.has_colour);
        let placed = logo.placed.unwrap();
        assert_eq!((placed.x, placed.y, placed.scale), (18.0, 18.0, 1.0));
    }
}
