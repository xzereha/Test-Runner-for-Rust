import * as vscode from "vscode";
import { runCargo } from "./cargoRunner";
import {
    findTestLocations as resolveTestLocations,
    parseDocTestLocation,
} from "./testLocation";

const DOCTEST_GROUP_PATH = "$doctests";

export type CargoTest = {
    name: string;
    item: vscode.TestItem;
    modules: string[];
};

export type CargoProject = {
    root: vscode.TestItem;
    doctestGroup?: vscode.TestItem;
    cwd: string;
    tests: Map<string, CargoTest>;
    modules: Map<string, vscode.TestItem>;
};

export async function discover(
    project: CargoProject,
    controller: vscode.TestController,
): Promise<void> {
    clearDiscoveredTests(project, controller);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
        const { code, output } = await runCargo(
            project.cwd,
            ["test", "--", "--list", "--format", "terse"],
            tokenSource.token,
        );
        if (code !== 0) {
            throw new Error(output || "Cargo test discovery failed.");
        }
        await addListedTests(project, controller, output);
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

export function getVisibleModulePath(modules: string[]): string[] {
    return modules.filter((moduleName) => moduleName !== "tests");
}

export function getTestDisplayPath(name: string): {
    modules: string[];
    label: string;
} {
    const { modules, label } = getTestPath(name);
    return {
        modules: parseDocTestLocation(name)
            ? [DOCTEST_GROUP_PATH]
            : getVisibleModulePath(modules),
        label,
    };
}

function clearDiscoveredTests(
    project: CargoProject,
    controller: vscode.TestController,
): void {
    project.root.children.replace([]);
    if (project.doctestGroup) {
        controller.items.delete(project.doctestGroup.id);
        project.doctestGroup = undefined;
    }
    project.tests.clear();
    project.modules.clear();
}

function getOrCreateDoctestGroup(
    project: CargoProject,
    controller: vscode.TestController,
): vscode.TestItem {
    if (project.doctestGroup) {
        return project.doctestGroup;
    }
    const group = controller.createTestItem(
        `${project.root.id}::doctest`,
        `${project.root.label}::doctest`,
        project.root.uri,
    );
    project.doctestGroup = group;
    project.modules.set(DOCTEST_GROUP_PATH, group);
    controller.items.add(group);
    return group;
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
    location?: { uri: vscode.Uri; range: vscode.Range },
): void {
    const { modules: visibleModules, label } = getTestDisplayPath(name);
    const isDocTest = parseDocTestLocation(name) !== undefined;
    const parent = isDocTest
        ? getOrCreateDoctestGroup(project, controller)
        : getTestParent(project, controller, visibleModules);
    const item = controller.createTestItem(
        `${project.root.id}::test::${name}`,
        label,
        location?.uri,
    );
    if (location) {
        item.range = location.range;
    }
    project.tests.set(name, { name, item, modules: visibleModules });
    parent.children.add(item);
}

async function addListedTests(
    project: CargoProject,
    controller: vscode.TestController,
    output: string,
): Promise<void> {
    const names = parseTestListing(output);
    const rootUri = project.root.uri ?? vscode.Uri.file(project.cwd);
    const locations = await resolveTestLocations(rootUri, names);
    for (const name of names) {
        addDiscoveredTest(project, controller, name, locations.get(name));
    }
}
