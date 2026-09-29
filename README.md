# Test Runner for Rust

Run Rust tests from VS Code's Test Explorer using Cargo.

## Features

- Discovers tests in Cargo projects using `cargo test -- --list --format terse`.
- Groups discovered tests by their Rust module paths in Test Explorer.
- Runs the full suite or an individual discovered test from the Test Explorer.
- Streams Cargo output into the test run and supports cancellation.
- Refreshes discovery when workspace folders change or with **Cargo: Refresh Tests**.

## Requirements

- Rust toolchain with Cargo available on `PATH`.
- Open a workspace folder that contains a `Cargo.toml`.

Tests are grouped by module beneath each workspace folder. Only the default Run profile is implemented; source-level test decorations are not yet available.
