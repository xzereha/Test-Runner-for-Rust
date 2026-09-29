import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type CargoTest = {
    name: string;
    item: vscode.TestItem;
    modules: string[];
};
type CargoProject = {
    root: vscode.TestItem;
    cwd: string;
    tests: Map<string, CargoTest>;
    modules: Map<string, vscode.TestItem>;
};

function runCargo(
    cwd: string,
    args: string[],
    token: vscode.CancellationToken,
    onOutput: (text: string) => void,
): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
        const process: ChildProcessWithoutNullStreams = spawn("cargo", args, {
            cwd,
        });
        let stdout = "";
        let stderr = "";
        const cancellation = token.onCancellationRequested(() =>
            process.kill(),
        );

        process.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            onOutput(text);
        });
        process.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            onOutput(text);
        });
        process.on("error", (error) => {
            cancellation.dispose();
            reject(error);
        });
        process.on("close", (code) => {
            cancellation.dispose();
            if (stderr && !stdout) {
                stdout = stderr;
            }
            resolve({ code, stdout });
        });
    });
}

export function parseTestListing(output: string): string[] {
    return [...output.matchAll(/^(.+): test$/gm)].map((match) => match[1]);
}

export function getTestPath(name: string): {
    modules: string[];
    label: string;
} {
    const parts = name.split("::");
    return { modules: parts.slice(0, -1), label: parts[parts.length - 1] };
}

function discover(
    project: CargoProject,
    controller: vscode.TestController,
): Promise<void> {
    project.root.children.replace([]);
    project.tests.clear();
    project.modules.clear();
    const tokenSource = new vscode.CancellationTokenSource();
    return runCargo(
        project.cwd,
        ["test", "--", "--list", "--format", "terse"],
        tokenSource.token,
        () => undefined,
    )
        .then(({ code, stdout }) => {
            if (code !== 0) {
                throw new Error(stdout || "Cargo test discovery failed.");
            }
            for (const name of parseTestListing(stdout)) {
                const { modules, label } = getTestPath(name);
                let parent = project.root;
                for (let index = 0; index < modules.length; index += 1) {
                    const path = modules.slice(0, index + 1).join("::");
                    let module = project.modules.get(path);
                    if (!module) {
                        module = controller.createTestItem(
                            `${project.root.id}::module::${path}`,
                            modules[index],
                            project.root.uri,
                        );
                        project.modules.set(path, module);
                        parent.children.add(module);
                    }
                    parent = module;
                }
                const item = controller.createTestItem(
                    `${project.root.id}::test::${name}`,
                    label,
                    project.root.uri,
                );
                project.tests.set(name, { name, item, modules });
                parent.children.add(item);
            }
        })
        .finally(() => tokenSource.dispose());
}

function applyResults(
    tests: CargoTest[],
    run: vscode.TestRun,
    output: string,
    code: number | null,
): void {
    const results = new Map<string, string>();
    for (const match of output.matchAll(
        /^test (.+) \.\.\. (ok|FAILED|ignored)(?: .*)?$/gm,
    )) {
        results.set(match[1], match[2]);
    }
    for (const { name, item } of tests) {
        switch (results.get(name)) {
            case "ok":
                run.passed(item);
                break;
            case "ignored":
                run.skipped(item);
                break;
            case "FAILED":
                run.failed(
                    item,
                    new vscode.TestMessage(`Test failed: ${name}`),
                );
                break;
            default:
                if (code !== 0 && code !== null) {
                    run.failed(
                        item,
                        new vscode.TestMessage(
                            output || `Cargo exited with code ${code}.`,
                        ),
                    );
                } else {
                    run.skipped(item);
                }
        }
    }
}

export function selectTests(
    project: CargoProject,
    request: Pick<vscode.TestRunRequest, "include" | "exclude">,
): { tests: CargoTest[]; runAsSuite: boolean } | undefined {
    const projectItems = new Set<vscode.TestItem>([
        project.root,
        ...project.modules.values(),
        ...[...project.tests.values()].map(({ item }) => item),
    ]);
    const included = request.include?.filter((item) => projectItems.has(item));
    if (request.include && included?.length === 0) {
        return undefined;
    }
    const rootIncluded = included?.includes(project.root) ?? !request.include;
    const excluded = new Set(request.exclude?.map((item) => item.id) ?? []);
    if (excluded.has(project.root.id)) {
        return undefined;
    }
    const includedModules = [...project.modules]
        .filter(([, item]) => included?.includes(item))
        .map(([path]) => path);
    const excludedModules = [...project.modules]
        .filter(([, item]) => excluded.has(item.id))
        .map(([path]) => path);
    const isWithinModules = (modules: string[], paths: string[]): boolean =>
        paths.some(
            (path) =>
                modules.slice(0, path.split("::").length).join("::") === path,
        );
    const tests = [...project.tests.values()].filter(
        ({ item, modules }) =>
            (rootIncluded ||
                included?.includes(item) ||
                isWithinModules(modules, includedModules)) &&
            !excluded.has(item.id) &&
            !isWithinModules(modules, excludedModules),
    );
    if (tests.length === 0) {
        return undefined;
    }
    const excludesProjectItems =
        request.exclude?.some((item) => projectItems.has(item)) ?? false;
    return { tests, runAsSuite: rootIncluded && !excludesProjectItems };
}

async function runTestBatch(
    project: CargoProject,
    tests: CargoTest[],
    runAsSuite: boolean,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    output: vscode.OutputChannel,
): Promise<void> {
    for (const { item } of tests) {
        run.started(item);
    }
    try {
        const args = runAsSuite
            ? ["test", "--", "--color", "never"]
            : ["test", "--", tests[0].name, "--exact", "--color", "never"];
        const { code, stdout } = await runCargo(
            project.cwd,
            args,
            token,
            (text) => run.appendOutput(text),
        );
        applyResults(tests, run, stdout, code);
    } catch (error) {
        for (const { item } of tests) {
            run.failed(
                item,
                new vscode.TestMessage(
                    `Could not start Cargo: ${String(error)}`,
                ),
            );
        }
        output.appendLine(
            `Cargo execution failed in ${project.cwd}: ${String(error)}`,
        );
    }
}

async function runRequestedTests(
    projects: Map<string, CargoProject>,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    run: vscode.TestRun,
    output: vscode.OutputChannel,
): Promise<void> {
    for (const project of projects.values()) {
        const selection = selectTests(project, request);
        if (!selection) {
            continue;
        }
        const batches = selection.runAsSuite
            ? [selection.tests]
            : selection.tests.map((test) => [test]);
        for (const batch of batches) {
            await runTestBatch(
                project,
                batch,
                selection.runAsSuite,
                run,
                token,
                output,
            );
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const controller = vscode.tests.createTestController(
        "cargo-tests",
        "Cargo Tests",
    );
    const projects = new Map<string, CargoProject>();
    const output = vscode.window.createOutputChannel("Cargo Tests");

    const refresh = async (project?: CargoProject): Promise<void> => {
        const targets = project ? [project] : [...projects.values()];
        await Promise.all(
            targets.map(async (target) => {
                try {
                    await discover(target, controller);
                } catch (error) {
                    output.appendLine(
                        `Test discovery failed in ${target.cwd}: ${String(error)}`,
                    );
                    vscode.window.showWarningMessage(
                        `Could not discover Cargo tests in ${target.cwd}. See the Cargo Tests output for details.`,
                    );
                }
            }),
        );
    };

    const addWorkspace = (folder: vscode.WorkspaceFolder): void => {
        const cwd = folder.uri.fsPath;
        const root = controller.createTestItem(
            `cargo:${cwd}`,
            folder.name,
            folder.uri,
        );
        const project = {
            root,
            cwd,
            tests: new Map<string, CargoTest>(),
            modules: new Map<string, vscode.TestItem>(),
        };
        projects.set(root.id, project);
        controller.items.add(root);
        void refresh(project);
    };

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        addWorkspace(folder);
    }
    const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(
        (event) => {
            for (const folder of event.removed) {
                const id = `cargo:${folder.uri.fsPath}`;
                projects.delete(id);
                controller.items.delete(id);
            }
            for (const folder of event.added) {
                addWorkspace(folder);
            }
        },
    );

    const refreshCommand = vscode.commands.registerCommand(
        "test-runner-for-rust.refreshTests",
        () => refresh(),
    );
    controller.refreshHandler = () => refresh();
    const runProfile = controller.createRunProfile(
        "Run Cargo Tests",
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
            const run = controller.createTestRun(request);
            await runRequestedTests(projects, request, token, run, output);
            run.end();
        },
        true,
    );
    context.subscriptions.push(
        controller,
        output,
        workspaceListener,
        refreshCommand,
        runProfile,
    );
}
