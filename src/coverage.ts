import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { runCargo } from "./cargoRunner";
import { formatCargoOutput, selectTests } from "./testExecution";
import type { CargoProject } from "./testDiscovery";

export type ParsedCoverageFile = {
    uri: vscode.Uri;
    details: vscode.FileCoverageDetail[];
};

export function parseLcovReport(
    report: string,
    workspaceRoot: vscode.Uri,
): ParsedCoverageFile[] {
    const files: ParsedCoverageFile[] = [];
    let sourceFile: string | undefined;
    let details: vscode.FileCoverageDetail[] = [];

    const finishRecord = (): void => {
        if (!sourceFile || details.length === 0) {
            return;
        }
        const absolutePath = isAbsolute(sourceFile)
            ? resolve(sourceFile)
            : resolve(workspaceRoot.fsPath, sourceFile);
        const relativePath = relative(workspaceRoot.fsPath, absolutePath);
        if (
            relativePath === ".." ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            return;
        }
        files.push({ uri: vscode.Uri.file(absolutePath), details });
    };

    for (const line of report.split(/\r?\n/)) {
        if (line.startsWith("SF:")) {
            finishRecord();
            sourceFile = line.slice(3);
            details = [];
            continue;
        }
        if (line === "end_of_record") {
            finishRecord();
            sourceFile = undefined;
            details = [];
            continue;
        }
        if (!line.startsWith("DA:")) {
            continue;
        }
        const [lineNumberText, executionCountText] = line.slice(3).split(",");
        const lineNumber = Number(lineNumberText);
        const executionCount = Number(executionCountText);
        if (
            Number.isInteger(lineNumber) &&
            lineNumber > 0 &&
            Number.isFinite(executionCount)
        ) {
            details.push(
                new vscode.StatementCoverage(
                    executionCount,
                    new vscode.Position(lineNumber - 1, 0),
                ),
            );
        }
    }
    finishRecord();
    return files;
}

export async function runCoverage(
    projects: Map<string, CargoProject>,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
    detailsByFile: Map<string, vscode.FileCoverageDetail[]>,
): Promise<void> {
    const selectedProjects = [...projects.values()].filter((project) =>
        selectTests(project, request),
    );
    if (selectedProjects.length === 0) {
        return;
    }

    const firstProject = selectedProjects[0];
    if (!(await ensureTarpaulin(firstProject.cwd, token, run))) {
        return;
    }

    return selectedProjects.reduce(
        (previous, project) =>
            previous.then(() => {
                if (token.isCancellationRequested) {
                    return;
                }
                return runProjectCoverage(
                    project,
                    token,
                    run,
                    output,
                    detailsByFile,
                );
            }),
        Promise.resolve(),
    );
}

async function ensureTarpaulin(
    cwd: string,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
): Promise<boolean> {
    let check: { code: number | null; output: string };
    try {
        check = await runCargo(cwd, ["tarpaulin", "--version"], token);
    } catch (error) {
        run.appendOutput(`${formatError(error)}\r\n`);
        return false;
    }
    if (check.code === 0) {
        return true;
    }

    const choice = await vscode.window.showWarningMessage(
        "Cargo Tarpaulin is required for code coverage. Install it with Cargo?",
        "Install cargo-tarpaulin",
    );
    if (choice !== "Install cargo-tarpaulin") {
        return false;
    }

    const install = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Installing cargo-tarpaulin",
            cancellable: false,
        },
        () => runCargo(cwd, ["install", "cargo-tarpaulin", "--locked"], token),
    );
    run.appendOutput(formatCargoOutput(install.output));
    if (install.code !== 0) {
        vscode.window.showErrorMessage(
            `Could not install cargo-tarpaulin. See the Cargo Tests output for details.`,
        );
        return false;
    }

    try {
        const verification = await runCargo(
            cwd,
            ["tarpaulin", "--version"],
            token,
        );
        if (verification.code === 0) {
            return true;
        }
        run.appendOutput(formatCargoOutput(verification.output));
    } catch (error) {
        run.appendOutput(`${formatError(error)}\r\n`);
    }
    vscode.window.showErrorMessage(
        "cargo-tarpaulin was installed but Cargo could not run the subcommand. Restart VS Code or check your Cargo PATH.",
    );
    return false;
}

async function runProjectCoverage(
    project: CargoProject,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
    detailsByFile: Map<string, vscode.FileCoverageDetail[]>,
): Promise<void> {
    const outputDirectory = await mkdtemp(join(tmpdir(), "cargo-coverage-"));
    try {
        const result = await runCargo(
            project.cwd,
            [
                "tarpaulin",
                "--manifest-path",
                join(project.cwd, "Cargo.toml"),
                "--workspace",
                "--out",
                "Lcov",
                "--output-dir",
                outputDirectory,
                "--color",
                "never",
            ],
            token,
        );
        run.appendOutput(formatCargoOutput(result.output));
        const reportPath = join(outputDirectory, "lcov.info");
        let report: string;
        try {
            report = await readFile(reportPath, "utf8");
        } catch {
            throw new Error(
                result.output ||
                    `Tarpaulin exited with code ${result.code} without producing lcov.info.`,
            );
        }
        const files = parseLcovReport(
            report,
            project.root.uri ?? vscode.Uri.file(project.cwd),
        );
        for (const file of files) {
            detailsByFile.set(file.uri.toString(), file.details);
            run.addCoverage(
                vscode.FileCoverage.fromDetails(file.uri, file.details),
            );
        }
        if (files.length === 0) {
            output.appendLine(
                `Tarpaulin produced no workspace coverage for ${project.cwd}.`,
            );
        }
    } catch (error) {
        const message = formatError(error);
        output.appendLine(`Coverage failed in ${project.cwd}: ${message}`);
        vscode.window.showErrorMessage(
            `Coverage failed in ${project.cwd}. See the Cargo Tests output for details.`,
        );
    } finally {
        await rm(outputDirectory, { recursive: true, force: true });
    }
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? "Unknown error");
}
