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

export function findTestFunctionLine(
    source: string,
    testName: string,
): number | undefined {
    if (!/^(?:r#)?[A-Za-z_]\w*$/.test(testName)) {
        return undefined;
    }
    const functionName = testName.replace(/^r#/, "");
    const declaration = new RegExp(
        String.raw`\bfn\s+(?:r#)?${functionName}\s*(?:<[^\n]*>)?\s*\(`,
    );
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        if (declaration.test(lines[index]) && hasTestAttribute(lines, index)) {
            return index;
        }
    }
    return undefined;
}

export function parseDocTestLocation(
    name: string,
): { relativePath: string; line: number } | undefined {
    const match = /^(.+\.rs) - (?:.* )?\(line (\d+)\)$/.exec(name);
    if (!match) {
        return undefined;
    }
    return { relativePath: match[1], line: Number(match[2]) - 1 };
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
    location?: { uri: vscode.Uri; line: number },
): void {
    const { modules, label } = getTestPath(name);
    const visibleModules = getVisibleModulePath(modules);
    const parent = getTestParent(project, controller, visibleModules);
    const item = controller.createTestItem(
        `${project.root.id}::test::${name}`,
        label,
        location?.uri,
    );
    if (location) {
        item.range = new vscode.Range(location.line, 0, location.line, 0);
    }
    project.tests.set(name, { name, item, modules: visibleModules });
    parent.children.add(item);
}

function hasTestAttribute(lines: string[], declarationLine: number): boolean {
    for (let index = declarationLine - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line || line.startsWith("//")) {
            continue;
        }
        if (line.startsWith("#[")) {
            if (/^#\[\s*(?:\w+::)*(?:test|rstest|test_case)\b/.test(line)) {
                return true;
            }
            continue;
        }
        return false;
    }
    return false;
}

async function findTestLocations(
    project: CargoProject,
    names: string[],
): Promise<Map<string, { uri: vscode.Uri; line: number }>> {
    const locations = new Map<string, { uri: vscode.Uri; line: number }>();
    const functionTests: string[] = [];
    const rootUri = project.root.uri ?? vscode.Uri.file(project.cwd);
    for (const name of names) {
        const docTest = parseDocTestLocation(name);
        if (docTest) {
            locations.set(name, {
                uri: vscode.Uri.joinPath(
                    rootUri,
                    ...docTest.relativePath.split("/"),
                ),
                line: docTest.line,
            });
        } else {
            functionTests.push(name);
        }
    }
    if (functionTests.length === 0) {
        return locations;
    }

    const tests = functionTests.map((name) => ({ name, ...getTestPath(name) }));
    const labels = new Set(tests.map(({ label }) => label));
    const candidates = new Map<
        string,
        Array<{ uri: vscode.Uri; line: number }>
    >();
    let files: vscode.Uri[];
    try {
        files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootUri, "**/*.rs"),
            "**/{target,.git}/**",
        );
    } catch {
        return locations;
    }

    await Promise.all(
        files.map(async (uri) => {
            let source: string;
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                source = new TextDecoder().decode(bytes);
            } catch {
                return;
            }
            for (const label of labels) {
                const line = findTestFunctionLine(source, label);
                if (line === undefined) {
                    continue;
                }
                const matches = candidates.get(label) ?? [];
                matches.push({ uri, line });
                candidates.set(label, matches);
            }
        }),
    );

    for (const test of tests) {
        const matches = candidates.get(test.label) ?? [];
        if (matches.length === 1) {
            locations.set(test.name, matches[0]);
            continue;
        }
        const moduleNames = test.modules.slice(1);
        const scored = matches.map((match) => ({
            ...match,
            score: moduleNames.filter((moduleName) =>
                match.uri.fsPath
                    .split(/[\\/]/)
                    .some(
                        (part) =>
                            part === moduleName || part === `${moduleName}.rs`,
                    ),
            ).length,
        }));
        scored.sort((left, right) => right.score - left.score);
        if (scored.length > 0 && scored[0].score > (scored[1]?.score ?? -1)) {
            locations.set(test.name, scored[0]);
        }
    }
    return locations;
}

async function addListedTests(
    project: CargoProject,
    controller: vscode.TestController,
    output: string,
): Promise<void> {
    const names = parseTestListing(output);
    const locations = await findTestLocations(project, names);
    for (const name of names) {
        addDiscoveredTest(project, controller, name, locations.get(name));
    }
}
