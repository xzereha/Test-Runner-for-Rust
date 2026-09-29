import * as assert from "assert";
import * as vscode from "vscode";
import { getTestPath, parseTestListing, selectTests } from "../extension";

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

    test("selects tests within an included module", () => {
        const root = createItem("project");
        const crateModule = createItem("project::module::crate");
        const testsModule = createItem("project::module::crate::tests");
        const nestedTest = {
            name: "crate::tests::works",
            item: createItem("project::test::crate::tests::works"),
            modules: ["crate", "tests"],
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
                ["crate::tests", testsModule],
            ]),
            tests: new Map([
                [nestedTest.name, nestedTest],
                [siblingTest.name, siblingTest],
            ]),
        };
        const result = selectTests(project, {
            include: [testsModule],
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
        const testsModule = createItem("project::module::crate::tests");
        const nestedTest = {
            name: "crate::tests::works",
            item: createItem("project::test::crate::tests::works"),
            modules: ["crate", "tests"],
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
                ["crate::tests", testsModule],
            ]),
            tests: new Map([
                [nestedTest.name, nestedTest],
                [siblingTest.name, siblingTest],
            ]),
        };
        const result = selectTests(project, {
            include: [root],
            exclude: [testsModule],
        });

        assert.deepStrictEqual(
            result?.tests.map(({ name }) => name),
            [siblingTest.name],
        );
    });
});
