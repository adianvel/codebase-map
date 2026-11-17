//! The few JavaScript behaviours that leak into report-check messages, kept
//! so the Rust check prints exactly what the Node check printed.

use serde_json::Value;

/// `String(n)` for a JavaScript number.
pub fn num(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{n}");
    }
    // JavaScript switches to exponent form outside that range: 1e+21, 1e-7.
    let exp = format!("{n:e}");
    match exp.split_once('e') {
        Some((mantissa, power)) if !power.starts_with('-') => format!("{mantissa}e+{power}"),
        _ => exp,
    }
}

/// `String(value)` for a JSON value; `None` is `undefined`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `JSON.stringify(value)`; `None` is `undefined`, which stringifies to itself
/// when interpolated into a template literal.
pub fn stringify(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| stringify(Some(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Some(Value::Object(map)) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}:{}", Value::String(k.clone()), stringify(Some(v))))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Some(other) => other.to_string(),
    }
}

/// `parseFloat(raw)`: the longest numeric prefix after leading whitespace.
pub fn parse_float(raw: &str) -> f64 {
    let s = raw.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    if s[end..].starts_with("Infinity") {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let digits = |from: usize| {
        from + bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int_end = digits(end);
    let mut last = int_end;
    let mut seen = int_end > end;
    if bytes.get(int_end) == Some(&b'.') {
        let frac_end = digits(int_end + 1);
        if frac_end > int_end + 1 || seen {
            seen |= frac_end > int_end + 1;
            last = frac_end;
        }
    }
    if !seen {
        return f64::NAN;
    }
    if matches!(bytes.get(last), Some(b'e' | b'E')) {
        let mut exp = last + 1;
        if matches!(bytes.get(exp), Some(b'+' | b'-')) {
            exp += 1;
        }
        let exp_end = digits(exp);
        if exp_end > exp {
            last = exp_end;
        }
    }
    s[..last].parse().unwrap_or(f64::NAN)
}

/// `Number(raw)`: the whole string must be numeric; blank is 0.
pub fn number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64);
        }
    }
    match s.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return if s.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }
        }
        rest if rest.is_empty()
            || !rest
                .bytes()
                .all(|b| b.is_ascii_digit() || b".eE+-".contains(&b)) =>
        {
            return f64::NAN
        }
        _ => {}
    }
    s.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(num(120.0), "120");
        assert_eq!(num(37.5), "37.5");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(f64::NAN), "NaN");
        assert_eq!(num(1e21), "1e+21");
        assert_eq!(num(1e-7), "1e-7");
        assert_eq!(num(0.1 + 0.2), "0.30000000000000004");
    }

    #[test]
    fn values_print_like_string_and_json_stringify() {
        assert_eq!(string(None), "undefined");
        assert_eq!(string(Some(&json!(5))), "5");
        assert_eq!(string(Some(&json!(["a", null, 2]))), "a,,2");
        assert_eq!(string(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(stringify(None), "undefined");
        assert_eq!(stringify(Some(&json!("maybe"))), "\"maybe\"");
        assert_eq!(stringify(Some(&json!(1.0))), "1");
        assert_eq!(
            stringify(Some(&json!({"k": [1, "x"]}))),
            "{\"k\":[1,\"x\"]}"
        );
    }

    #[test]
    fn parse_float_reads_a_numeric_prefix() {
        assert_eq!(parse_float("12px"), 12.0);
        assert_eq!(parse_float("  -3.5e2x"), -350.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("5."), 5.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert!(parse_float("abc").is_nan());
        assert!(parse_float("").is_nan());
        assert!(parse_float(".").is_nan());
    }

    #[test]
    fn number_needs_the_whole_string() {
        assert_eq!(number(" 1040 "), 1040.0);
        assert_eq!(number(""), 0.0);
        assert_eq!(number("0x10"), 16.0);
        assert!(number("12px").is_nan());
        assert!(number("inf").is_nan());
        assert!(number("nan").is_nan());
    }
}
