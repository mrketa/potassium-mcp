import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { analyzeSourcePackage } from "../../src/code-analysis.js";

// Only test-authored source uses this direct parser. Production always injects the
// AppContainer-backed parseSourcePackage API and has no unrestricted fallback.
let languagePromise;
async function withAuthoredTrees(modules, useTrees) {
  languagePromise ??= (async () => {
    await Parser.init({ locateFile: () => fileURLToPath(import.meta.resolve("web-tree-sitter/tree-sitter.wasm")) });
    return Language.load(fileURLToPath(new URL("../fixtures/luau-parser/tree-sitter-luau.wasm", import.meta.url)));
  })();
  const language = await languagePromise;
  const parser = new Parser();
  const trees = [];
  try {
    parser.setLanguage(language);
    for (const module of modules) trees.push(parser.parse(module.source));
    return useTrees(trees);
  } finally {
    for (const tree of trees) tree.delete();
    parser.delete();
  }
}
export function parseAuthoredModules(modules) {
  return withAuthoredTrees(modules, (trees) => analyzeSourcePackage(modules, trees, { name: "tree-sitter-luau", version: "1.2.0", runtimeVersion: "0.25.10", analysisSchema: 1 }));
}

// Emulate the native wire shape from test-authored syntax for adapter regressions.
// The actual native executable/transport is qualified separately through its sandbox.
export function nativePayloadForAuthoredModules(modules) {
  return withAuthoredTrees(modules, (trees) => ({
    schema: 1,
    parser: { runtime: "tree-sitter", runtimeVersion: "0.25.0", grammar: "tree-sitter-luau", grammarVersion: "1.2.0" },
    truncated: false,
    trees: trees.map((tree, moduleIndex) => {
      const source = modules[moduleIndex].source;
      const nodes = [];
      const byte = (index) => Buffer.byteLength(source.slice(0, index));
      const column = (index) => Buffer.byteLength(source.slice(source.lastIndexOf("\n", index - 1) + 1, index));
      function serialize(node) {
        const id = nodes.length;
        const result = { type: node.type, startByte: byte(node.startIndex), endByte: byte(node.endIndex), startRow: node.startPosition.row, startByteColumn: column(node.startIndex), endRow: node.endPosition.row, endByteColumn: column(node.endIndex), named: node.isNamed, missing: node.isMissing, hasError: node.hasError, children: [], fields: {} };
        nodes.push(result);
        for (let index = 0; index < node.childCount; index += 1) {
          const childId = serialize(node.child(index));
          result.children.push(childId);
          const name = node.fieldNameForChild(index);
          if (name) (result.fields[name] ??= []).push(childId);
        }
        return id;
      }
      return { root: serialize(tree.rootNode), nodes };
    }),
  }));
}
export function authoredModule(source, id = "Main", logicalPath = `Root/${id}`) {
  return { id, logicalPath, source, sha256: createHash("sha256").update(source).digest("hex") };
}
export function terminalOrigin(result, origin) {
  const bindings = new Map(result.facts.bindings.map((fact) => [fact.id, fact]));
  const seen = new Set();
  while (origin.kind === "binding") {
    if (seen.has(origin.bindingId)) throw new Error("Unexpected origin cycle");
    seen.add(origin.bindingId);
    origin = bindings.get(origin.bindingId).origin;
  }
  return origin;
}
