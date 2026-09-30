import * as vscode from "vscode";
import { runCargo } from "./cargoRunner";

export type CargoTest = {
    name: string;
    item: vscode.TestItem;
    modules: string[];
};

export type CargoProject = {
    root: vscode.TestItem;
    cwd: string;
    tests: Map<string, CargoTest>;
    modules: Map<string, vscode.TestItem>;
};

export async function discover(
    project: CargoProject,
    controller: vscode.TestController,
): Promise<void> {
    clearDiscoveredTests(project);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
        const { code, stdout } = await runCargo(
            project.cwd,
            ["test", "--", "--list", "--format", "terse"],
            tokenSource.token,
            () => undefined,
        );
        if (code !== 0) {
            throw new Error(stdout || "Cargo test discovery failed.");
        }
        addListedTests(project, controller, stdout);
    } finally {
        tokenSource.dispose();
    }
}

export function parseTestListing(output: string): string[] {
    return [...output.matchAll(/^(.+): test$/gm)].map((match) => match[1]);
}

export function getTestPath(name: string): {
    modules: string[];
    label: string;
} {
    const parts = name.split("::");
    return { modules: parts.slice(0, -1), label: parts.at(-1) ?? "" };
}

function clearDiscoveredTests(project: CargoProject): void {
    project.root.children.replace([]);
    project.tests.clear();
    project.modules.clear();
}

function getOrCreateModule(
    project: CargoProject,
    controller: vscode.TestController,
    parent: vscode.TestItem,
    path: string,
    label: string,
): vscode.TestItem {
    const existing = project.modules.get(path);
    if (existing) {
        return existing;
    }

    const module = controller.createTestItem(
        `${project.root.id}::module::${path}`,
        label,
        project.root.uri,
    );
    project.modules.set(path, module);
    parent.children.add(module);
    return module;
}

function getTestParent(
    project: CargoProject,
    controller: vscode.TestController,
    modules: string[],
): vscode.TestItem {
    let parent = project.root;
    for (let index = 0; index < modules.length; index += 1) {
        const path = modules.slice(0, index + 1).join("::");
        parent = getOrCreateModule(
            project,
            controller,
            parent,
            path,
            modules[index],
        );
    }
    return parent;
}

function addDiscoveredTest(
    project: CargoProject,
    controller: vscode.TestController,
    name: string,
): void {
    const { modules, label } = getTestPath(name);
    const parent = getTestParent(project, controller, modules);
    const item = controller.createTestItem(
        `${project.root.id}::test::${name}`,
        label,
        project.root.uri,
    );
    project.tests.set(name, { name, item, modules });
    parent.children.add(item);
}

function addListedTests(
    project: CargoProject,
    controller: vscode.TestController,
    output: string,
): void {
    for (const name of parseTestListing(output)) {
        addDiscoveredTest(project, controller, name);
    }
}
