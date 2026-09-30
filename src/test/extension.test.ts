import * as assert from "assert";
import * as vscode from "vscode";
import {
    formatCargoOutput,
    getTestPath,
    getVisibleModulePath,
    parseTestResults,
    parseTestListing,
    selectTests,
} from "../extension";
import {
    getRustModulePath,
    getSymbolLocationKey,
    parseDocTestLocation,
    selectTestSymbol,
} from "../testLocation";

function createItem(id: string): vscode.TestItem {
    return { id } as vscode.TestItem;
}

suite("Cargo test discovery", () => {
    test("parses terse Cargo test listings", () => {
        const listing =
            "crate::works: test\ncrate::ignored: test\n2 tests, 0 benchmarks";
        assert.deepStrictEqual(parseTestListing(listing), [
            "crate::works",
            "crate::ignored",
        ]);
    });

    test("matches expected-panic result names to listed test names", () => {
        const results = parseTestResults(
            "test entity::tests::panics - should panic ... ok\ntest entity::tests::unexpected - should panic ... FAILED",
        );

        assert.deepStrictEqual(
            [...results],
            [
                ["entity::tests::panics", "ok"],
                ["entity::tests::unexpected", "FAILED"],
            ],
        );
    });

    test("formats Cargo test output as one unindented line per test", () => {
        const escape = String.fromCodePoint(0x1b);
        const output = `${escape}[33m    Doc-tests ecs_rs${escape}[0m\r\n${escape}[120Crunning 2 tests\r${escape}[200C${escape}[32mtest first ... ok${escape}[0m\r\n       test second ... ok\r\n    ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s`;

        assert.strictEqual(
            formatCargoOutput(output),
            "Doc-tests ecs_rs\nrunning 2 tests\ntest first ... ok\ntest second ... ok\nok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s",
        );
    });

    test("splits test names into module paths and labels", () => {
        assert.deepStrictEqual(getTestPath("crate::tests::works"), {
            modules: ["crate", "tests"],
            label: "works",
        });
        assert.deepStrictEqual(getTestPath("works"), {
            modules: [],
            label: "works",
        });
    });

    test("flattens tests module names from visible paths", () => {
        assert.deepStrictEqual(
            getVisibleModulePath(["crate", "tests", "nested"]),
            ["crate", "nested"],
        );
    });

    test("parses source locations from Cargo doctest names", () => {
        assert.deepStrictEqual(
            parseDocTestLocation(
                "src/query/maybe.rs - query::maybe::Option<&'aT> (line 15)",
            ),
            { relativePath: "src/query/maybe.rs", line: 14 },
        );
        assert.deepStrictEqual(parseDocTestLocation("src/lib.rs - (line 6)"), {
            relativePath: "src/lib.rs",
            line: 5,
        });
    });

    test("selects same-named Rust symbols by module path", () => {
        const workspaceRoot = vscode.Uri.file("/project");
        const getTest = new vscode.SymbolInformation(
            "returns_value",
            vscode.SymbolKind.Function,
            new vscode.Range(10, 0, 10, 20),
            vscode.Uri.file("/project/src/store.rs"),
            "tests::get",
        );
        const getMutTest = new vscode.SymbolInformation(
            "returns_value",
            vscode.SymbolKind.Function,
            new vscode.Range(20, 0, 20, 20),
            vscode.Uri.file("/project/src/store.rs"),
            "tests::get_mut",
        );

        assert.strictEqual(
            selectTestSymbol(
                [getTest, getMutTest],
                "ecs_rs::tests::get::returns_value",
                workspaceRoot,
            ),
            getTest,
        );
        assert.strictEqual(
            selectTestSymbol(
                [getTest, getMutTest],
                "ecs_rs::tests::get_mut::returns_value",
                workspaceRoot,
            ),
            getMutTest,
        );
    });

    test("disambiguates same-named symbols by source module scope", () => {
        const workspaceRoot = vscode.Uri.file("/project");
        const uri = vscode.Uri.file("/project/src/store.rs");
        const getTest = new vscode.SymbolInformation(
            "returns_value",
            vscode.SymbolKind.Function,
            new vscode.Range(3, 0, 3, 20),
            uri,
        );
        const getMutTest = new vscode.SymbolInformation(
            "returns_value",
            vscode.SymbolKind.Function,
            new vscode.Range(7, 0, 7, 20),
            uri,
        );
        const source = [
            "mod tests {",
            "    mod get {",
            "        #[test]",
            "        fn returns_value() {}",
            "    }",
            "    mod get_mut {",
            "        #[test]",
            "        fn returns_value() {}",
            "    }",
            "}",
        ].join("\n");
        const modulePaths = new Map([
            [getSymbolLocationKey(getTest), getRustModulePath(source, 3)],
            [getSymbolLocationKey(getMutTest), getRustModulePath(source, 7)],
        ]);

        assert.deepStrictEqual(modulePaths.get(getSymbolLocationKey(getTest)), [
            "tests",
            "get",
        ]);
        assert.strictEqual(
            selectTestSymbol(
                [getTest, getMutTest],
                "ecs_rs::tests::get::returns_value",
                workspaceRoot,
                modulePaths,
            ),
            getTest,
        );
        assert.strictEqual(
            selectTestSymbol(
                [getTest, getMutTest],
                "ecs_rs::tests::get_mut::returns_value",
                workspaceRoot,
                modulePaths,
            ),
            getMutTest,
        );
    });

    test("selects tests within an included module", () => {
        const root = createItem("project");
        const crateModule = createItem("project::module::crate");
        const unitModule = createItem("project::module::crate::unit");
        const nestedTest = {
            name: "crate::tests::unit::works",
            item: createItem("project::test::crate::tests::unit::works"),
            modules: ["crate", "unit"],
        };
        const siblingTest = {
            name: "crate::other",
            item: createItem("project::test::crate::other"),
            modules: ["crate"],
        };
        const project = {
            root,
            cwd: "/project",
            modules: new Map([
                ["crate", crateModule],
                ["crate::unit", unitModule],
            ]),
            tests: new Map([
                [nestedTest.name, nestedTest],
                [siblingTest.name, siblingTest],
            ]),
        };
        const result = selectTests(project, {
            include: [unitModule],
            exclude: undefined,
        });

        assert.deepStrictEqual(
            result?.tests.map(({ name }) => name),
            [nestedTest.name],
        );
    });

    test("excludes tests within an excluded module", () => {
        const root = createItem("project");
        const crateModule = createItem("project::module::crate");
        const unitModule = createItem("project::module::crate::unit");
        const nestedTest = {
            name: "crate::tests::unit::works",
            item: createItem("project::test::crate::tests::unit::works"),
            modules: ["crate", "unit"],
        };
        const siblingTest = {
            name: "crate::other",
            item: createItem("project::test::crate::other"),
            modules: ["crate"],
        };
        const project = {
            root,
            cwd: "/project",
            modules: new Map([
                ["crate", crateModule],
                ["crate::unit", unitModule],
            ]),
            tests: new Map([
                [nestedTest.name, nestedTest],
                [siblingTest.name, siblingTest],
            ]),
        };
        const result = selectTests(project, {
            include: [root],
            exclude: [unitModule],
        });

        assert.deepStrictEqual(
            result?.tests.map(({ name }) => name),
            [siblingTest.name],
        );
    });
});
