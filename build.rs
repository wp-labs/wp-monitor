use std::path::Path;
use std::process::Command;

fn detect_pm() -> Option<&'static str> {
    ["pnpm", "npm"].into_iter().find(|pm| {
        Command::new(pm)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

fn run_build(pm: &str) {
    if !Path::new("frontend/node_modules").exists() {
        let output = Command::new(pm)
            .arg("install")
            .current_dir("frontend")
            .output();
        if let Ok(o) = &output
            && !o.status.success()
        {
            println!(
                "cargo:warning={pm} install failed: {}",
                String::from_utf8_lossy(&o.stderr)
            );
            return;
        }
    }

    let output = Command::new(pm)
        .args(["run", "build"])
        .current_dir("frontend")
        .output();
    if let Ok(o) = &output
        && !o.status.success()
    {
        println!(
            "cargo:warning=frontend build failed: {}",
            String::from_utf8_lossy(&o.stderr)
        );
    }
}

fn main() {
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/package.json");

    if std::env::var("PROFILE").unwrap_or_default() == "release" {
        return;
    }

    match detect_pm() {
        Some(pm) => run_build(pm),
        None => println!("cargo:warning=no pnpm or npm found, skipping frontend build"),
    }
}
