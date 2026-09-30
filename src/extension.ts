import * as vscode from "vscode";
import { checkCargoExecutable, getResolvedCargoPath } from "./cargoRunner";
import { discover, type CargoProject, type CargoTest } from "./testDiscovery";
import { runRequestedTests } from "./testExecution";

export {
    findTestFunctionLine,
    getTestPath,
    parseDocTestLocation,
    parseTestListing,
} from "./testDiscovery";
export { formatCargoOutput, selectTests } from "./testExecution";

async function refreshProject(
    project: CargoProject,
    controller: vscode.TestController,
    output: vscode.OutputChannel,
): Promise<void> {
    try {
        await discover(project, controller);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(
            `Test discovery failed in ${project.cwd}: ${message}`,
        );
        vscode.window.showWarningMessage(
            `Could not discover Cargo tests in ${project.cwd}. ${message}`,
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

function clearProjectTests(projects: Map<string, CargoProject>): void {
    for (const project of projects.values()) {
        project.root.children.replace([]);
        project.tests.clear();
        project.modules.clear();
    }
}

function showCargoUnavailable(
    message: string,
    output: vscode.OutputChannel,
): void {
    output.appendLine(message);
    vscode.window.showWarningMessage(
        `${message} Test discovery and runs are paused until the Cargo path setting changes.`,
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
    let cargoAvailable = false;

    const refresh = (project?: CargoProject): Promise<void> =>
        cargoAvailable
            ? refreshProjects(projects, controller, output, project)
            : Promise.resolve();

    const checkCargo = async (): Promise<void> => {
        const error = await checkCargoExecutable();
        if (error) {
            cargoAvailable = false;
            clearProjectTests(projects);
            showCargoUnavailable(error, output);
            return;
        }
        cargoAvailable = true;
        void refresh();
    };

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
        if (cargoAvailable) {
            void refresh(project);
        }
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
    const cargoPathListener = vscode.workspace.onDidChangeConfiguration(
        (event) => {
            if (!event.affectsConfiguration("test-runner-for-rust.cargoPath")) {
                return;
            }
            const configuredPath = vscode.workspace
                .getConfiguration("test-runner-for-rust")
                .get<string>("cargoPath");
            if (configuredPath === getResolvedCargoPath()) {
                return;
            }
            void checkCargo();
        },
    );
    void checkCargo();

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
        cargoPathListener,
        refreshCommand,
        runProfile,
    );
}
