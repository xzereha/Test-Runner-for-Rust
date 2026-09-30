import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";

function getCargoExecutable(): string {
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

export function runCargo(
    cwd: string,
    args: string[],
    token: vscode.CancellationToken,
    onOutput: (text: string) => void,
): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
        let cargoProcess: ChildProcessWithoutNullStreams;
        try {
            cargoProcess = spawn(getCargoExecutable(), args, { cwd });
        } catch (error) {
            reject(error);
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
            reject(error);
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
