//! Diagram Model extraction.
//!
//! One interface: `parse_diagrams(html, geometry)`. Everything the Report
//! Verifier needs to know about a drawn diagram (viewBox, nodes with
//! footprints and technology marks, segmented edges, and labels) is extracted
//! here, so the geometry and mark checks consume the model and never the raw
//! markup. The footprint dimensions come from the supplied geometry
//! (docs/diagram-geometry.json); without them a node falls back to its tile.

use regex::Regex;
use serde_json::Value;

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

/// `(?-u:\b){name}\s*=\s*"([^"]*)"`, compiled once per attribute name.
fn attribute(el: &str, name: &str) -> Option<String> {
    let re = match name {
        "x" => regex!(r#"(?-u:\b)x\s*=\s*"([^"]*)""#),
        "y" => regex!(r#"(?-u:\b)y\s*=\s*"([^"]*)""#),
        "width" => regex!(r#"(?-u:\b)width\s*=\s*"([^"]*)""#),
        "height" => regex!(r#"(?-u:\b)height\s*=\s*"([^"]*)""#),
        "d" => regex!(r#"(?-u:\b)d\s*=\s*"([^"]*)""#),
        "transform" => regex!(r#"(?-u:\b)transform\s*=\s*"([^"]*)""#),
        "viewBox" => regex!(r#"(?-u:\b)viewBox\s*=\s*"([^"]*)""#),
        "data-tech" => regex!(r#"(?-u:\b)data-tech\s*=\s*"([^"]*)""#),
        "text-anchor" => regex!(r#"(?-u:\b)text-anchor\s*=\s*"([^"]*)""#),
        other => {
            let re = Regex::new(&format!(
                r#"(?-u:\b){}\s*=\s*"([^"]*)""#,
                regex::escape(other)
            ))
            .ok()?;
            return re.captures(el).map(|c| c[1].to_string());
        }
    };
    re.captures(el).map(|c| c[1].to_string())
}

fn number_attribute(el: &str, name: &str) -> f64 {
    let value = attribute(el, name).map_or(f64::NAN, |raw| js::parse_float(&raw));
    if value.is_finite() {
        value
    } else {
        f64::NAN
    }
}

fn transform_of(el: &str) -> Option<Placement> {
    let raw = attribute(el, "transform").filter(|raw| !raw.is_empty())?;
    let r#move = regex!(r"translate\(\s*(-?[0-9.]+)[ ,]+(-?[0-9.]+)\s*\)").captures(&raw)?;
    let zoom = regex!(r"scale\(\s*(-?[0-9.]+)\s*\)").captures(&raw)?;
    Some(Placement {
        x: js::parse_float(&r#move[1]),
        y: js::parse_float(&r#move[2]),
        scale: js::parse_float(&zoom[1]),
    })
}

fn decoded_text(raw: &str) -> String {
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

fn segments_of(d: &str) -> Option<Vec<Segment>> {
    let tokens: Vec<&str> = regex!("[MLHVZmlhvz][^MLHVZmlhvz]*")
        .find_iter(d)
        .map(|m| m.as_str())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let (mut cursor_x, mut cursor_y) = (0.0, 0.0);
    let mut segments = Vec::new();
    for token in tokens {
        let command = token.chars().next()?;
        if command.is_ascii_lowercase() {
            return None;
        }
        if command == 'Z' {
            continue;
        }
        let args: Vec<f64> = regex!(r"-?[0-9]*\.?[0-9]+")
            .find_iter(&token[1..])
            .map(|m| js::number(m.as_str()))
            .collect();
        let arg = |i: usize| args.get(i).copied().unwrap_or(f64::NAN);
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

fn parse_diagram(svg: &str, fonts: &StatedFontSizes, geometry: &Value) -> Diagram {
    let view_box = view_box_of(svg);
    let title = regex!(r"<title[^>]*>([\s\S]*?)</title>").captures(svg);
    let mut nodes = Vec::new();
    for block in regex!(r"<a(?-u:\b)[\s\S]*?</a>")
        .find_iter(svg)
        .map(|m| m.as_str())
    {
        let Some(rect) =
            regex!(r#"<rect(?-u:\b)[^>]*class="[^"]*(?-u:\b)tile(?-u:\b)[^"]*"[^>]*>"#).find(block)
        else {
            continue;
        };
        let tile = box_of(rect.as_str());
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
        let label_re = regex!(
            r#"<text(?-u:\b)[^>]*class="[^"]*(?-u:\b)node-(title|subtitle)(?-u:\b)[^"]*"[^>]*>([^<]*)</text>"#
        );
        for caps in label_re.captures_iter(block) {
            let class_name = match &caps[1] {
                "title" => "node-title",
                "subtitle" => "node-subtitle",
                _ => continue,
            };
            let Some(font_size) = fonts.for_class(class_name) else {
                continue;
            };
            labels.push(NodeLabel {
                kind: caps[1].to_string(),
                chars: js_len(&decoded_text(&caps[2])),
                font_size,
            });
        }

        let logo =
            regex!(r#"<g(?-u:\b)[^>]*class="[^"]*(?-u:\b)tile-logo(?-u:\b)[^"]*"[\s\S]*?</g>"#)
                .find(block)
                .map(|found| {
                    let raw = found.as_str();
                    let group = regex!(r"^<g(?-u:\b)[^>]*>")
                        .find(raw)
                        .map_or("", |m| m.as_str());
                    Logo {
                        slug: attribute(group, "data-tech"),
                        has_colour: regex!(r"(?i)(?-u:\b)(?:fill|stroke|color|style)\s*=")
                            .is_match(raw),
                        path: regex!(r#"<path(?-u:\b)[^>]*(?-u:\b)d\s*=\s*"([^"]*)""#)
                            .captures(raw)
                            .map(|c| c[1].to_string()),
                        placed: transform_of(group),
                    }
                });
        let kind_code = regex!(r#"class="[^"]*(?-u:\b)tile-mark(?-u:\b)"#).is_match(block);
        nodes.push(Node {
            footprint,
            tile,
            labels,
            logo,
            kind_code,
        });
    }

    let mut edges = Vec::new();
    for found in regex!(r#"<path(?-u:\b)[^>]*class="[^"]*(?-u:\b)edge-[^"]*"[^>]*"#).find_iter(svg)
    {
        let Some(d) = attribute(found.as_str(), "d").filter(|d| !d.is_empty()) else {
            continue;
        };
        let segments = segments_of(&d);
        edges.push(Edge { d, segments });
    }

    let mut labels = Vec::new();
    let text_re = regex!(
        r#"<text(?-u:\b)[^>]*class="[^"]*(?-u:\b)(edge-label|boundary-label)(?-u:\b)[^"]*"[^>]*>([^<]*)</text>"#
    );
    for caps in text_re.captures_iter(svg) {
        let Some(font_size) = fonts.for_class(&caps[1]) else {
            continue;
        };
        let kind = caps[1].to_string();
        let tag = &caps[0];
        let content = decoded_text(&caps[2]);
        labels.push(Label {
            chars: js_len(&content),
            content,
            font_size,
            x: number_attribute(tag, "x"),
            y: number_attribute(tag, "y"),
            anchor: attribute(tag, "text-anchor")
                .filter(|a| !a.is_empty())
                .unwrap_or_else(|| "start".into()),
            kind,
        });
    }

    let name = title.map_or_else(|| "diagram".into(), |c| c[1].trim().to_string());
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
