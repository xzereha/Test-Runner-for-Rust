import * as vscode from "vscode";
import { runCargo } from "./cargoRunner";
import type { CargoProject, CargoTest } from "./testDiscovery";

type TestResult = "ok" | "FAILED" | "ignored";

export function runRequestedTests(
    projects: Map<string, CargoProject>,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
): Promise<void> {
    return [...projects.values()].reduce(
        (previous, project) =>
            previous.then(() =>
                runProjectTests(project, request, token, run, output),
            ),
        Promise.resolve(),
    );
}

export function selectTests(
    project: CargoProject,
    request: Pick<vscode.TestRunRequest, "include" | "exclude">,
): { tests: CargoTest[]; runAsSuite: boolean } | undefined {
    const projectItems = getProjectItems(project);
    const included = request.include?.filter((item) => projectItems.has(item));
    if (request.include && included?.length === 0) {
        return undefined;
    }
    const rootIncluded = included?.includes(project.root) ?? !request.include;
    const excluded = new Set(request.exclude?.map((item) => item.id) ?? []);
    if (excluded.has(project.root.id)) {
        return undefined;
    }
    const includedModules = getIncludedModulePaths(project, included);
    const excludedModules = getExcludedModulePaths(project, excluded);
    const tests = [...project.tests.values()].filter((test) =>
        matchesSelection(
            test,
            rootIncluded,
            included,
            includedModules,
            excluded,
            excludedModules,
        ),
    );
    if (tests.length === 0) {
        return undefined;
    }
    const excludesProjectItems =
        request.exclude?.some((item) => projectItems.has(item)) ?? false;
    return { tests, runAsSuite: rootIncluded && !excludesProjectItems };
}

export function formatCargoOutput(output: string): string {
    return stripTerminalSequences(output)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/^[\t ]+/gm, "");
}

function stripTerminalSequences(text: string): string {
    const escape = String.fromCodePoint(0x1b);
    const bell = String.fromCodePoint(0x07);
    const terminalSequence = new RegExp(
        String.raw`${escape}(?:\[[0-?]*[ -/]*[@-~]|\][^${bell}]*(?:${bell}|${escape}\\))`,
        "g",
    );
    return text.replace(terminalSequence, "");
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error) ?? "Unknown error";
    } catch {
        return "Unknown error";
    }
}

function parseResults(output: string): Map<string, TestResult> {
    const results = new Map<string, TestResult>();
    for (const match of output.matchAll(
        /^test (.+) \.\.\. (ok|FAILED|ignored)(?: .*)?$/gm,
    )) {
        results.set(match[1], match[2] as TestResult);
    }
    return results;
}

function applyTestResult(
    test: CargoTest,
    result: TestResult | undefined,
    run: vscode.TestRun,
    output: string,
    code: number | null,
): void {
    if (result === "ok") {
        run.passed(test.item);
    } else if (result === "ignored") {
        run.skipped(test.item);
    } else if (result === "FAILED") {
        run.failed(
            test.item,
            new vscode.TestMessage(`Test failed: ${test.name}`),
        );
    } else if (code !== 0 && code !== null) {
        run.failed(
            test.item,
            new vscode.TestMessage(output || `Cargo exited with code ${code}.`),
        );
    } else {
        run.skipped(test.item);
    }
}

function applyResults(
    tests: CargoTest[],
    run: vscode.TestRun,
    output: string,
    code: number | null,
): void {
    const results = parseResults(output);
    for (const test of tests) {
        applyTestResult(test, results.get(test.name), run, output, code);
    }
}

function getProjectItems(project: CargoProject): Set<vscode.TestItem> {
    return new Set<vscode.TestItem>([
        project.root,
        ...project.modules.values(),
        ...[...project.tests.values()].map(({ item }) => item),
    ]);
}

function isWithinModules(modules: string[], paths: string[]): boolean {
    return paths.some(
        (path) => modules.slice(0, path.split("::").length).join("::") === path,
    );
}

function getIncludedModulePaths(
    project: CargoProject,
    included: vscode.TestItem[] | undefined,
): string[] {
    return [...project.modules]
        .filter(([, item]) => included?.includes(item))
        .map(([path]) => path);
}

function getExcludedModulePaths(
    project: CargoProject,
    excluded: Set<string>,
): string[] {
    return [...project.modules]
        .filter(([, item]) => excluded.has(item.id))
        .map(([path]) => path);
}

function matchesSelection(
    test: CargoTest,
    rootIncluded: boolean,
    included: vscode.TestItem[] | undefined,
    includedModules: string[],
    excluded: Set<string>,
    excludedModules: string[],
): boolean {
    return (
        (rootIncluded ||
            included?.includes(test.item) ||
            isWithinModules(test.modules, includedModules)) &&
        !excluded.has(test.item.id) &&
        !isWithinModules(test.modules, excludedModules)
    );
}

function getCargoTestArgs(tests: CargoTest[], runAsSuite: boolean): string[] {
    return runAsSuite
        ? ["test", "--", "--color", "never"]
        : ["test", "--", tests[0].name, "--exact", "--color", "never"];
}

function markTestsStarted(tests: CargoTest[], run: vscode.TestRun): void {
    for (const { item } of tests) {
        run.started(item);
    }
}

function reportCargoFailure(
    project: CargoProject,
    tests: CargoTest[],
    error: unknown,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
): void {
    const message = formatError(error);
    for (const { item } of tests) {
        run.failed(
            item,
            new vscode.TestMessage(`Could not start Cargo: ${message}`),
        );
    }
    output.appendLine(`Cargo execution failed in ${project.cwd}: ${message}`);
}

async function runTestBatch(
    project: CargoProject,
    tests: CargoTest[],
    runAsSuite: boolean,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    output: vscode.OutputChannel,
): Promise<void> {
    markTestsStarted(tests, run);
    try {
        const { code, output } = await runCargo(
            project.cwd,
            getCargoTestArgs(tests, runAsSuite),
            token,
        );
        run.appendOutput(formatCargoOutput(output));
        applyResults(tests, run, output, code);
    } catch (error) {
        reportCargoFailure(project, tests, error, run, output);
    }
}

function runProjectTests(
    project: CargoProject,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
): Promise<void> {
    const selection = selectTests(project, request);
    if (!selection) {
        return Promise.resolve();
    }
    const batches = selection.runAsSuite
        ? [selection.tests]
        : selection.tests.map((test) => [test]);
    return batches.reduce(
        (previous, batch) =>
            previous.then(() =>
                runTestBatch(
                    project,
                    batch,
                    selection.runAsSuite,
                    run,
                    token,
                    output,
                ),
            ),
        Promise.resolve(),
    );
}
