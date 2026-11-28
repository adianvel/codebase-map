//! The codebase-map report check: a Report Verifier with zero filesystem
//! dependencies, the Diagram Model it measures, and the embedded Report
//! Contract assets. The `check-report` binary is the FileSystem Adapter.

mod diagram;
mod js;
mod verifier;

pub use verifier::{verify_report, verify_report_phases, Contract, PhaseNanos, REQUIRED_FILES};
