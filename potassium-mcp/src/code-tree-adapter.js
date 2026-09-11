import { createHash } from "node:crypto";
import { analyzeSourcePackage } from "./code-analysis.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200000;
const MAX_DEPTH = 512;
const MAX_FILE_BYTES = 262144;
const MAX_SOURCE_BYTES = 4194304;
const nodeKeys = new Set(["type", "startByte", "endByte", "startRow", "startByteColumn", "endRow", "endByteColumn", "named", "missing", "hasError", "children", "fields"]);
const parserIdentity = Object.freeze({ name: "tree-sitter-luau", version: "1.2.0", runtime: "tree-sitter", runtimeVersion: "0.25.0", analysisSchema: 1, nativeTreeSchema: 1 });
function failure(message, code = "PARSER_TREE_INVALID") { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { return Object.keys(value).every((key) => allowed.has(key)); }
function integer(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }

/** Build byte-boundary and line maps once. Non-boundary UTF-8 positions stay -1. */
function sourcePositions(source, byteLength) {
  const byteToIndex = new Int32Array(byteLength + 1).fill(-1);
  let lineCount = 1;
  for (let index = 0; index < source.length; index += 1) if (source.charCodeAt(index) === 10) lineCount += 1;
  const lineStarts = new Uint32Array(lineCount);
  let byte = 0;
  let row = 0;
  for (let index = 0; index < source.length;) {
    byteToIndex[byte] = index;
    const point = source.codePointAt(index);
    const units = point > 0xffff ? 2 : 1;
    byte += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    index += units;
    if (point === 10) lineStarts[++row] = index;
  }
  if (byte !== byteLength) failure("Native tree source byte identity is invalid");
  byteToIndex[byte] = source.length;
  function position(offset, row, column) {
    if (!integer(offset, byteLength) || byteToIndex[offset] < 0 || !integer(row, lineStarts.length - 1) || !integer(column, offset)) failure("Native tree position is not a source boundary");
    const index = byteToIndex[offset];
    const lineStart = lineStarts[row];
    if (index < lineStart || (row + 1 < lineStarts.length && index >= lineStarts[row + 1]) || byteToIndex[offset - column] !== lineStart) failure("Native tree row or byte column does not match its source");
    return { index, row, column: index - lineStart };
  }
  return position;
}

function adaptTree(tree, source, byteLength, budget) {
  if (!object(tree) || !keys(tree, new Set(["root", "nodes"])) || tree.root !== 0 || !Array.isArray(tree.nodes) || tree.nodes.length < 1) failure("Native tree structure is invalid");
  const raw = tree.nodes;
  budget.nodes += raw.length;
  if (budget.nodes > MAX_NODES) failure("Native tree node limit exceeded");
  const position = sourcePositions(source, byteLength);
  const parents = new Uint32Array(raw.length);
  const nodes = new Array(raw.length);
  let edgeCount = 0;
  for (let id = 0; id < raw.length; id += 1) {
    const node = raw[id];
    if (!object(node) || !keys(node, nodeKeys) || typeof node.type !== "string" || node.type.length < 1 || node.type.length > 128 || !node.type.isWellFormed() || /[\u0000-\u001f\u007f]/.test(node.type)
      || typeof node.named !== "boolean" || typeof node.missing !== "boolean" || typeof node.hasError !== "boolean" || !Array.isArray(node.children) || !object(node.fields)) failure("Native tree node shape is invalid");
    const start = position(node.startByte, node.startRow, node.startByteColumn);
    const end = position(node.endByte, node.endRow, node.endByteColumn);
    if (node.startByte > node.endByte || (node.missing && node.startByte !== node.endByte)) failure("Native tree node range is invalid");
    edgeCount += node.children.length;
    if (edgeCount > raw.length - 1) failure("Native tree contains excessive child edges");
    for (const child of node.children) {
      if (!integer(child, raw.length - 1) || child === id || child === tree.root || ++parents[child] !== 1) failure("Native tree child references are cyclic or shared");
    }
    nodes[id] = { id, type: node.type, startIndex: start.index, endIndex: end.index, startPosition: { row: start.row, column: start.column }, endPosition: { row: end.row, column: end.column }, isNamed: node.named, isMissing: node.missing, hasError: node.hasError,
      get text() { return source.slice(this.startIndex, this.endIndex); },
    };
  }
  if (edgeCount !== raw.length - 1) failure("Native tree has unreachable nodes");
  for (let id = 0; id < raw.length; id += 1) {
    const node = nodes[id];
    const serialized = raw[id];
    const children = serialized.children.map((child) => nodes[child]);
    const childOrder = new Map();
    let previousEnd = node.startIndex;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.startIndex < previousEnd || child.endIndex > node.endIndex) failure("Native tree children overlap or escape their parent");
      previousEnd = child.endIndex;
      childOrder.set(child.id, index);
    }
    const names = Object.keys(serialized.fields);
    if (names.length > 64) failure("Native tree field limit exceeded");
    const fields = new Map();
    const assignedFields = new Set();
    for (const name of names) {
      const references = serialized.fields[name];
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) || !Array.isArray(references) || references.length < 1) failure("Native tree field shape is invalid");
      budget.fields += references.length;
      if (budget.fields > MAX_NODES * 8) failure("Native tree field reference limit exceeded");
      let previous = -1;
      const mapped = [];
      for (const reference of references) {
        const order = childOrder.get(reference);
        if (!Number.isSafeInteger(reference) || order === undefined || order <= previous) failure("Native tree fields are not ordered direct-child references");
        if (assignedFields.has(reference)) failure("Native tree child is assigned to multiple fields");
        assignedFields.add(reference);
        previous = order;
        mapped.push(nodes[reference]);
      }
      fields.set(name, mapped);
    }
    node.children = children;
    node.namedChildren = children.filter((child) => child.isNamed);
    node.childCount = children.length;
    node.child = (index) => children[index] ?? null;
    node.childForFieldName = (name) => fields.get(name)?.[0] ?? null;
    node.childrenForFieldName = (name) => fields.get(name) ?? [];
  }
  // Single-parent counts alone do not exclude a disconnected cycle. Walk the root
  // iteratively and enforce reachability/depth before the semantic analyzer sees it.
  const seen = new Uint8Array(nodes.length);
  const stack = [[0, 0]];
  let visited = 0;
  while (stack.length) {
    const [id, depth] = stack.pop();
    if (seen[id] || depth > MAX_DEPTH) failure("Native tree contains a cycle or excessive depth");
    seen[id] = 1;
    visited += 1;
    for (let index = nodes[id].children.length - 1; index >= 0; index -= 1) stack.push([nodes[id].children[index].id, depth + 1]);
  }
  if (visited !== nodes.length) failure("Native tree contains unreachable nodes");
  return { rootNode: nodes[tree.root] };
}

/** Native parsing is sandboxed. This host-side adapter only validates data and
 * analyzes bounded syntax; it does not parse, evaluate, import or execute Luau. */
export function analyzeNativeSourcePackage(modules, payload) {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 32) failure("Parser module package is invalid", "PARSER_INVALID_INPUT");
  let sourceBytes = 0;
  const lengths = [];
  const ids = new Set();
  const paths = new Set();
  for (const module of modules) {
    if (!object(module) || typeof module.id !== "string" || module.id.length < 1 || module.id.length > 128 || !module.id.isWellFormed() || /[\u0000-\u001f\u007f]/.test(module.id)
      || typeof module.logicalPath !== "string" || module.logicalPath.length < 1 || module.logicalPath.length > 512 || !module.logicalPath.isWellFormed() || /[\\:\u0000-\u001f\u007f]/.test(module.logicalPath)
      || module.logicalPath.split("/").some((part) => !part || part === "." || part === "..") || ids.has(module.id) || paths.has(module.logicalPath)
      || typeof module.source !== "string" || !module.source.isWellFormed() || typeof module.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(module.sha256)) failure("Parser module source or identity is invalid", "PARSER_INVALID_INPUT");
    ids.add(module.id); paths.add(module.logicalPath);
    const length = Buffer.byteLength(module.source);
    lengths.push(length);
    sourceBytes += length;
    if (length > MAX_FILE_BYTES || sourceBytes > MAX_SOURCE_BYTES) failure("Parser source exceeds the byte limit", "PARSER_INPUT_LIMIT");
    if (createHash("sha256").update(module.source).digest("hex") !== module.sha256) failure("Parser source hash does not match", "PARSER_INVALID_INPUT");
  }
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { failure("Native parser result is not bounded JSON"); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_BYTES) failure("Native parser result exceeds the byte limit");
  if (!object(payload) || !keys(payload, new Set(["schema", "parser", "trees", "truncated"])) || payload.schema !== 1 || payload.truncated !== false || !object(payload.parser)
    || !keys(payload.parser, new Set(["runtime", "runtimeVersion", "grammar", "grammarVersion"])) || payload.parser.runtime !== "tree-sitter" || payload.parser.runtimeVersion !== "0.25.0"
    || payload.parser.grammar !== "tree-sitter-luau" || payload.parser.grammarVersion !== "1.2.0" || !Array.isArray(payload.trees) || payload.trees.length !== modules.length) failure("Native parser identity or result shape is invalid");
  const budget = { nodes: 0, fields: 0 };
  const trees = payload.trees.map((tree, index) => adaptTree(tree, modules[index].source, lengths[index], budget));
  return analyzeSourcePackage(modules, trees, { ...parserIdentity });
}
