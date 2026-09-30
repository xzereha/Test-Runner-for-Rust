import { isAbsolute, relative, sep } from "node:path";
import * as vscode from "vscode";

export type TestLocation = {
    uri: vscode.Uri;
    range: vscode.Range;
};

export function parseDocTestLocation(
    name: string,
): { relativePath: string; line: number } | undefined {
    const match = /^(.+\.rs) - (?:.* )?\(line (\d+)\)$/.exec(name);
    if (!match) {
        return undefined;
    }
    return { relativePath: match[1], line: Number(match[2]) - 1 };
}

export function selectTestSymbol(
    symbols: vscode.SymbolInformation[],
    testName: string,
    workspaceRoot: vscode.Uri,
    sourceModulePaths: Map<string, string[]> = new Map(),
): vscode.SymbolInformation | undefined {
    const parts = testName.split("::");
    const label = parts.pop() ?? "";
    const expectedModules = parts.filter(
        (moduleName) => moduleName !== "tests",
    );
    const rootPath = workspaceRoot.fsPath;
    const matchingSymbols = symbols.filter((symbol) => {
        const relativePath = relative(rootPath, symbol.location.uri.fsPath);
        return (
            symbol.kind === vscode.SymbolKind.Function &&
            symbol.name.replace(/^r#/, "") === label.replace(/^r#/, "") &&
            relativePath !== ".." &&
            !relativePath.startsWith(`..${sep}`) &&
            !isAbsolute(relativePath)
        );
    });
    if (matchingSymbols.length === 1) {
        return matchingSymbols[0];
    }

    const scored = matchingSymbols.map((symbol) => {
        const containerParts = new Set(
            (symbol.containerName ?? "")
                .split("::")
                .filter((part) => part !== "tests"),
        );
        const relativeParts = new Set(
            relative(rootPath, symbol.location.uri.fsPath)
                .split(/[\\/]/)
                .map((part) => part.replace(/\.rs$/, "")),
        );
        return {
            symbol,
            score: expectedModules.filter(
                (moduleName) =>
                    containerParts.has(moduleName) ||
                    relativeParts.has(moduleName) ||
                    new Set(
                        sourceModulePaths.get(getSymbolLocationKey(symbol)) ??
                            [],
                    ).has(moduleName),
            ).length,
        };
    });
    scored.sort((left, right) => right.score - left.score);
    if (scored.length > 0 && scored[0].score > (scored[1]?.score ?? -1)) {
        return scored[0].symbol;
    }
    return undefined;
}

export function getSymbolLocationKey(symbol: vscode.SymbolInformation): string {
    return `${symbol.location.uri.toString()}:${symbol.location.range.start.line}`;
}

export function getRustModulePath(
    source: string,
    targetLine: number,
): string[] {
    const lines = source.split(/\r?\n/);
    const moduleStack: Array<{ name: string; closeDepth: number }> = [];
    let braceDepth = 0;

    for (
        let index = 0;
        index <= targetLine && index < lines.length;
        index += 1
    ) {
        while (
            moduleStack.length > 0 &&
            moduleStack.at(-1)!.closeDepth > braceDepth
        ) {
            moduleStack.pop();
        }
        if (index === targetLine) {
            return moduleStack.map(({ name }) => name);
        }

        const moduleDeclaration =
            /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_]\w*)\s*\{/.exec(
                lines[index],
            );
        const lineBraceDelta = countRustBraces(lines[index]);
        braceDepth += lineBraceDelta;
        if (moduleDeclaration && lineBraceDelta > 0) {
            moduleStack.push({
                name: moduleDeclaration[1],
                closeDepth: braceDepth,
            });
        }
    }
    return [];
}

async function getSourceModulePaths(
    symbols: vscode.SymbolInformation[],
): Promise<Map<string, string[]>> {
    const entries: Array<[string, string[]]> = await Promise.all(
        symbols.map(async (symbol) => {
            try {
                const document = await vscode.workspace.openTextDocument(
                    symbol.location.uri,
                );
                return [
                    getSymbolLocationKey(symbol),
                    getRustModulePath(
                        document.getText(),
                        symbol.location.range.start.line,
                    ),
                ] as [string, string[]];
            } catch {
                return [getSymbolLocationKey(symbol), [] as string[]];
            }
        }),
    );
    return new Map<string, string[]>(entries);
}

function countRustBraces(line: string): number {
    const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"/g, "");
    const commentStart = withoutStrings.indexOf("//");
    const code =
        commentStart < 0
            ? withoutStrings
            : withoutStrings.slice(0, commentStart);
    let depth = 0;
    for (const character of code) {
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
        }
    }
    return depth;
}

export async function findTestLocations(
    workspaceRoot: vscode.Uri,
    testNames: string[],
): Promise<Map<string, TestLocation>> {
    const locations = new Map<string, TestLocation>();
    const symbolQueries = new Map<
        string,
        Promise<vscode.SymbolInformation[]>
    >();

    for (const testName of testNames) {
        const docTest = parseDocTestLocation(testName);
        if (docTest) {
            locations.set(testName, {
                uri: vscode.Uri.joinPath(
                    workspaceRoot,
                    ...docTest.relativePath.split("/"),
                ),
                range: new vscode.Range(docTest.line, 0, docTest.line, 0),
            });
            continue;
        }

        const label = testName.split("::").at(-1) ?? "";
        if (!symbolQueries.has(label)) {
            symbolQueries.set(
                label,
                Promise.resolve(
                    vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                        "vscode.executeWorkspaceSymbolProvider",
                        label,
                    ),
                ).catch(() => []),
            );
        }
    }

    const resolvedSymbols = new Map<string, vscode.SymbolInformation[]>();
    await Promise.all(
        [...symbolQueries].map(async ([label, query]) => {
            resolvedSymbols.set(label, await query);
        }),
    );
    const sourceModuleQueries = new Map<
        string,
        Promise<Map<string, string[]>>
    >();
    for (const [label, symbols] of resolvedSymbols) {
        if (symbols.length > 1) {
            sourceModuleQueries.set(label, getSourceModulePaths(symbols));
        }
    }
    const sourceModulePaths = new Map<string, Map<string, string[]>>();
    await Promise.all(
        [...sourceModuleQueries].map(async ([label, query]) => {
            sourceModulePaths.set(label, await query);
        }),
    );

    for (const testName of testNames) {
        if (locations.has(testName)) {
            continue;
        }
        const label = testName.split("::").at(-1) ?? "";
        const symbols = resolvedSymbols.get(label) ?? [];
        const symbol = selectTestSymbol(
            symbols,
            testName,
            workspaceRoot,
            sourceModulePaths.get(label),
        );
        if (symbol) {
            locations.set(testName, {
                uri: symbol.location.uri,
                range: symbol.location.range,
            });
        }
    }
    return locations;
}
