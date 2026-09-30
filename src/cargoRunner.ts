import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";

let resolvedCargoPath: string | undefined;

export async function checkCargoExecutable(): Promise<string | undefined> {
    const configuration = vscode.workspace.getConfiguration(
        "test-runner-for-rust",
    );
    const configuredPath = configuration.get<string>("cargoPath") ?? "";
    const cargoPath = findCargoExecutable(configuredPath);
    if (!cargoPath) {
        resolvedCargoPath = undefined;
        const checkedLocations = [
            configuredPath ? `"${configuredPath}"` : "the configured path",
            "PATH",
            `"${join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo")}"`,
            ...(process.platform === "win32" ? [] : ['"/usr/bin/cargo"']),
        ];
        return `Cargo was not found. Checked ${checkedLocations.join(", ")}. Install Rust and Cargo with rustup (https://rustup.rs), or set "test-runner-for-rust.cargoPath" to an executable Cargo path.`;
    }

    resolvedCargoPath = cargoPath;
    if (configuredPath !== cargoPath) {
        try {
            await configuration.update(
                "cargoPath",
                cargoPath,
                vscode.ConfigurationTarget.Global,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(
                `Cargo was found at "${cargoPath}" but could not be saved to settings: ${message}. It will be used for this session.`,
            );
        }
    }
    return undefined;
}

export function getResolvedCargoPath(): string | undefined {
    return resolvedCargoPath;
}

export function runCargo(
    cwd: string,
    args: string[],
    token: vscode.CancellationToken,
    onOutput: (text: string) => void,
): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
        let cargoPath = "";
        let cargoProcess: ChildProcessWithoutNullStreams;
        try {
            cargoPath = getCargoExecutable();
            cargoProcess = spawn(cargoPath, args, { cwd });
        } catch (error) {
            reject(formatSpawnError(error as Error, cargoPath, cwd));
            return;
        }
        let stdout = "";
        let stderr = "";
        const cancellation = token.onCancellationRequested(() =>
            cargoProcess.kill(),
        );

        cargoProcess.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            onOutput(text);
        });
        cargoProcess.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            onOutput(text);
        });
        cargoProcess.on("error", (error) => {
            cancellation.dispose();
            reject(formatSpawnError(error, cargoPath, cwd));
        });
        cargoProcess.on("close", (code) => {
            cancellation.dispose();
            if (stderr && !stdout) {
                stdout = stderr;
            }
            resolve({ code, stdout });
        });
    });
}

function getCargoExecutable(): string {
    if (resolvedCargoPath) {
        return resolvedCargoPath;
    }
    const configuredPath = vscode.workspace
        .getConfiguration("test-runner-for-rust")
        .get<string>("cargoPath");
    const cargoPath =
        configuredPath ||
        join(
            homedir(),
            ".cargo",
            "bin",
            process.platform === "win32" ? "cargo.exe" : "cargo",
        );
    if (!isAbsolute(cargoPath)) {
        throw new Error("The Cargo executable path must be absolute.");
    }
    return cargoPath;
}

function isExecutable(filePath: string): boolean {
    if (!isAbsolute(filePath)) {
        return false;
    }
    try {
        accessSync(
            filePath,
            process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function findOnPath(): string | undefined {
    const executableNames =
        process.platform === "win32" ? ["cargo.exe"] : ["cargo"];
    const directories = (process.env.PATH ?? "").split(delimiter);
    for (const directory of directories) {
        for (const name of executableNames) {
            const candidate = resolve(directory || process.cwd(), name);
            if (isExecutable(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}

function findCargoExecutable(configuredPath: string): string | undefined {
    if (configuredPath && isExecutable(configuredPath)) {
        return configuredPath;
    }
    const fromEnvironment = findOnPath();
    if (fromEnvironment) {
        return fromEnvironment;
    }
    const executableName = process.platform === "win32" ? "cargo.exe" : "cargo";
    const candidates = [
        join(homedir(), ".cargo", "bin", executableName),
        ...(process.platform === "win32" ? [] : ["/usr/bin/cargo"]),
    ];
    return candidates.find(isExecutable);
}

function formatSpawnError(error: Error, cargoPath: string, cwd: string): Error {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
        if (code === "EACCES" || code === "EPERM") {
            return new Error(
                `Cargo at "${cargoPath}" cannot be executed. Check its permissions, or set "test-runner-for-rust.cargoPath" to an executable Cargo binary.`,
            );
        }
        return error;
    }
    if (!existsSync(cargoPath)) {
        return new Error(
            `Cargo was not found at "${cargoPath}". Install Rust and Cargo with rustup (https://rustup.rs), or set "test-runner-for-rust.cargoPath" to Cargo's absolute path.`,
        );
    }
    if (!existsSync(cwd)) {
        return new Error(
            `The workspace folder "${cwd}" could not be found while starting Cargo.`,
        );
    }
    return error;
}
