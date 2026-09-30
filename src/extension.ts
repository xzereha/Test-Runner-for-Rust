import * as vscode from "vscode";
import { discover, type CargoProject, type CargoTest } from "./testDiscovery";
import { runRequestedTests } from "./testExecution";

export { getTestPath, parseTestListing } from "./testDiscovery";
export { selectTests } from "./testExecution";

async function refreshProject(
    project: CargoProject,
    controller: vscode.TestController,
    output: vscode.OutputChannel,
): Promise<void> {
    try {
        await discover(project, controller);
    } catch (error) {
        output.appendLine(
            `Test discovery failed in ${project.cwd}: ${String(error)}`,
        );
        vscode.window.showWarningMessage(
            `Could not discover Cargo tests in ${project.cwd}. See the Cargo Tests output for details.`,
        );
    }
}

async function refreshProjects(
    projects: Map<string, CargoProject>,
    controller: vscode.TestController,
    output: vscode.OutputChannel,
    project?: CargoProject,
): Promise<void> {
    const targets = project ? [project] : [...projects.values()];
    await Promise.all(
        targets.map((target) => refreshProject(target, controller, output)),
    );
}

function removeWorkspace(
    folder: vscode.WorkspaceFolder,
    projects: Map<string, CargoProject>,
    controller: vscode.TestController,
): void {
    const id = `cargo:${folder.uri.fsPath}`;
    projects.delete(id);
    controller.items.delete(id);
}

export function activate(context: vscode.ExtensionContext): void {
    const controller = vscode.tests.createTestController(
        "cargo-tests",
        "Cargo Tests",
    );
    const projects = new Map<string, CargoProject>();
    const output = vscode.window.createOutputChannel("Cargo Tests");

    const refresh = (project?: CargoProject): Promise<void> =>
        refreshProjects(projects, controller, output, project);

    const addWorkspace = (folder: vscode.WorkspaceFolder): void => {
        const cwd = folder.uri.fsPath;
        const root = controller.createTestItem(
            `cargo:${cwd}`,
            folder.name,
            folder.uri,
        );
        const project: CargoProject = {
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
                removeWorkspace(folder, projects, controller);
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
