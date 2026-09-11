export const ANALYSIS_LIMITS = Object.freeze({ maxNodes: 200000, maxDepth: 128, maxFacts: 12000, maxDiagnostics: 256, maxRedactions: 20000, maxScopeWork: 2000000, maxSemanticVisits: 200000, maxFactBytes: 4 * 1024 * 1024, maxArguments: 32, maxSnippetChars: 160 });

const factKinds = ["functions", "calls", "dependencies", "bindings"];
const ignoredTypes = new Set(["comment", "type_definition", "empty_statement", "break_statement", "continue_statement"]);
const field = (node, name) => node?.childForFieldName(name) ?? null;
const named = (node) => node?.namedChildren.filter((child) => child.type !== "comment") ?? [];
const short = (value, length = 128) => String(value).slice(0, length);
const location = (node) => ({ start: { line: node.startPosition.row + 1, column: node.startPosition.column + 1, offset: node.startIndex }, end: { line: node.endPosition.row + 1, column: node.endPosition.column + 1, offset: node.endIndex } });
const unknown = (reason, extra = {}) => ({ kind: "unresolved", confidence: "unresolved", reason, ...extra });

/** Pure AST analysis. The caller owns the parser/tree lifetime; source is never evaluated. */
export function analyzeSourcePackage(modules, trees, parser) {
  const facts = Object.fromEntries(factKinds.map((kind) => [kind, []]));
  const diagnostics = [];
  const files = [];
  const state = { nodes: 0, facts: 0, factBytes: 0, redactions: 0, scopeWork: 0, semanticVisits: 0, truncated: false, diagnosticsDropped: 0 };
  const hierarchy = new Map(modules.map((module) => [module.logicalPath, module.id]));
  const moduleIds = new Set(modules.map((module) => module.id));
  const bindingFacts = new Map();
  const budgetStop = Symbol("analysis-budget");

  function chargeScope(count) {
    state.scopeWork += count;
    if (state.scopeWork > ANALYSIS_LIMITS.maxScopeWork) { state.truncated = true; throw budgetStop; }
  }

  function visitSemantic() {
    state.semanticVisits += 1;
    if (state.semanticVisits > ANALYSIS_LIMITS.maxSemanticVisits) { state.truncated = true; throw budgetStop; }
  }

  function diagnostic(module, code, node, message) {
    if (diagnostics.length === ANALYSIS_LIMITS.maxDiagnostics) { state.truncated = true; state.diagnosticsDropped += 1; return; }
    diagnostics.push({ moduleId: module.id, sha256: module.sha256, code, severity: code === "PARSE_ERROR" ? "error" : "information", ...(node ? { span: location(node) } : {}), message });
  }
  function add(kind, fact) {
    const bytes = JSON.stringify(fact).length * 3;
    if (state.facts >= ANALYSIS_LIMITS.maxFacts || state.factBytes + bytes > ANALYSIS_LIMITS.maxFactBytes) {
      state.truncated = true;
      throw budgetStop;
    }
    facts[kind].push(fact);
    state.facts += 1;
    state.factBytes += bytes;
    return fact;
  }

  for (let fileIndex = 0; fileIndex < modules.length; fileIndex += 1) {
    const module = modules[fileIndex];
    const root = trees[fileIndex].rootNode;
    const initialFacts = state.facts;
    const initialDiagnostics = diagnostics.length;
    const file = { id: module.id, logicalPath: module.logicalPath, sha256: module.sha256, bytes: new TextEncoder().encode(module.source).length, parseErrors: false, truncated: false, facts: 0 };
    files.push(file);
    let serial = 0;
    let environmentUncertain = false;
    const capturedWrites = new Set();
    const callCache = new Map();
    const functionCache = new Map();
    const spansToRedact = [];
    const base = (node, prefix) => ({ id: `${fileIndex}:${prefix}:${node.startIndex}:${++serial}`, moduleId: module.id, sha256: module.sha256, span: location(node) });

    // This whole-tree pass also bounds grammar recovery, nesting and display redaction.
    try {
      const stack = [[root, 0]];
      while (stack.length) {
        const [node, depth] = stack.pop();
        state.nodes += 1;
        if (state.nodes > ANALYSIS_LIMITS.maxNodes || depth > ANALYSIS_LIMITS.maxDepth) { state.truncated = true; throw budgetStop; }
        if (node.type === "ERROR" || node.isMissing) {
          file.parseErrors = true;
          diagnostic(module, "PARSE_ERROR", node, node.isMissing ? "Missing syntax token" : "Unrecognized or incomplete Luau syntax");
        }
        if (node.type === "string" || node.type === "comment" || node.type === "number") {
          state.redactions += 1;
          if (state.redactions > ANALYSIS_LIMITS.maxRedactions) { state.truncated = true; throw budgetStop; }
          spansToRedact.push({ start: node.startIndex, end: node.endIndex, kind: node.type });
        }
        for (let i = node.childCount - 1; i >= 0; i -= 1) stack.push([node.child(i), depth + 1]);
      }
      if (root.hasError && !file.parseErrors) { file.parseErrors = true; diagnostic(module, "PARSE_ERROR", root, "Unrecognized or incomplete Luau syntax"); }
      if (file.parseErrors) continue;
      spansToRedact.sort((a, b) => a.start - b.start || b.end - a.end);
      const redactions = [];
      for (const span of spansToRedact) if (!redactions.length || span.start >= redactions.at(-1).end) redactions.push(span);
      file.redactions = redactions;
      function snippet(node) {
        const end = Math.min(node.endIndex, node.startIndex + ANALYSIS_LIMITS.maxSnippetChars);
        let text = "";
        let offset = node.startIndex;
        let low = 0;
        let high = redactions.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (redactions[middle].end <= offset) low = middle + 1; else high = middle;
        }
        for (let index = low; index < redactions.length; index += 1) {
          const span = redactions[index];
          if (span.start >= end) break;
          text += module.source.slice(offset, Math.max(offset, span.start));
          text += `[${span.kind}]`;
          offset = Math.max(offset, span.end);
        }
        if (offset < end) text += module.source.slice(offset, end);
        return short(text, ANALYSIS_LIMITS.maxSnippetChars);
      }
      const clone = (env) => {
        chargeScope(env.reduce((count, scope) => count + scope.size + 1, 0));
        return env.map((scope) => new Map(scope));
      };
      function lookup(env, name) {
        chargeScope(env.length);
        for (let i = env.length - 1; i >= 0; i -= 1) if (env[i].has(name)) return { index: i, entry: env[i].get(name) };
        return null;
      }
      function bind(env, node, name, origin, depth, local = false, declaration = false) {
        const existing = local ? null : lookup(env, name);
        const fact = add("bindings", { ...base(node, "binding"), name: short(name), scopeDepth: env.length - 1, functionDepth: depth, declaration, origin });
        bindingFacts.set(fact.id, fact);
        const index = local ? env.length - 1 : existing?.index ?? 0;
        env[index].set(name, { fact, depth: existing?.entry.depth ?? depth });
        if (!local && depth > 0 && (!existing || existing.entry.depth < depth)) capturedWrites.add(name);
        return fact;
      }
      function reference(env, node, depth) {
        const found = lookup(env, node.text);
        if (!found) {
          if (node.text === "script" && !environmentUncertain) return { kind: "logical-instance", confidence: "inferred", logicalPath: module.logicalPath };
          if (node.text === "require" && !environmentUncertain) return { kind: "builtin", name: "require", confidence: "inferred" };
          return unknown(environmentUncertain ? "environment-effect" : "global-or-unbound", { name: short(node.text) });
        }
        if (found.entry.depth < depth) return unknown("captured-upvalue", { bindingId: found.entry.fact.id, name: short(node.text) });
        return { kind: "binding", confidence: "direct", bindingId: found.entry.fact.id, name: short(node.text) };
      }
      function terminal(origin) {
        const seen = new Set();
        while (origin.kind === "binding" && seen.size < 128 && !seen.has(origin.bindingId)) {
          chargeScope(1);
          seen.add(origin.bindingId);
          origin = bindingFacts.get(origin.bindingId)?.origin ?? unknown("missing-binding");
        }
        return origin.kind === "binding" ? unknown("origin-depth") : origin;
      }
      function member(node, env, depth) {
        const table = expression(field(node, "table"), env, depth);
        const key = field(node, node.type === "method_index_expression" ? "method" : "field");
        const staticName = node.type !== "bracket_index_expression" && key?.type === "identifier" ? key.text : null;
        if (!staticName) { expression(key, env, depth); return unknown("dynamic-member"); }
        const resolved = terminal(table);
        if (resolved.kind === "logical-instance") {
          if (!resolved.logicalPath && staticName === "Parent") return unknown("logical-hierarchy-boundary");
          const parts = resolved.logicalPath ? resolved.logicalPath.split("/") : [];
          if (staticName === "Parent") parts.pop(); else parts.push(staticName);
          return { kind: "logical-instance", confidence: "inferred", logicalPath: parts.join("/") };
        }
        return { kind: "member", confidence: "unresolved", member: short(staticName), receiver: table, reason: "member-identity-unverified" };
      }
      function dependency(node, arg, origin, call) {
        let targetModuleId;
        let reason;
        let logicalPath;
        const resolved = terminal(origin);
        if (resolved.kind === "logical-instance") {
          logicalPath = resolved.logicalPath;
          targetModuleId = hierarchy.get(logicalPath);
          if (!targetModuleId) reason = "module-not-supplied";
        } else if (arg?.type === "string" && named(arg).every((child) => child.type === "string_content")) {
          const content = arg.childrenForFieldName("content").map((child) => child.text).join("");
          targetModuleId = moduleIds.has(content) ? content : hierarchy.get(content);
          reason = targetModuleId ? undefined : "string-module-not-supplied";
        } else reason = "dynamic-require";
        const edge = add("dependencies", { ...base(node, "require"), callsiteId: call.id, ...(targetModuleId ? { targetModuleId } : {}), ...(logicalPath ? { logicalPath: short(logicalPath, 512) } : {}), confidence: targetModuleId ? "inferred" : "unresolved", ...(reason ? { reason } : {}) });
        return edge;
      }
      function functionDisplayName(node) {
        if (!node) return "<anonymous>";
        if (node.type === "identifier") return short(node.text);
        if (node.type === "dot_index_expression" || node.type === "method_index_expression") {
          const method = node.type === "method_index_expression";
          const key = field(node, method ? "method" : "field");
          return short(`${functionDisplayName(field(node, "table"))}${method ? ":" : "."}${key?.type === "identifier" ? key.text : "<expression>"}`);
        }
        if (node.type === "bracket_index_expression") return short(`${functionDisplayName(field(node, "table"))}[<expression>]`);
        return "<expression>";
      }
      function analyzeFunction(node, env, depth, name = "<anonymous>") {
        if (functionCache.has(node.id)) return functionCache.get(node.id);
        const parameters = named(field(node, "parameters"));
        const names = parameters.map((parameter) => named(parameter).find((child) => child.type === "identifier" || child.type === "vararg_expression") ?? parameter).filter((parameter) => parameter.type === "identifier" || parameter.type === "vararg_expression");
        const fact = add("functions", { ...base(node, "function"), name: short(name), parameters: names.slice(0, ANALYSIS_LIMITS.maxArguments).map((parameter) => short(parameter.text)), parametersTruncated: names.length > ANALYSIS_LIMITS.maxArguments, confidence: "direct", snippet: snippet(node) });
        functionCache.set(node.id, fact);
        const bodyEnv = [...clone(env), new Map()];
        if (field(node, "name")?.type === "method_index_expression") bind(bodyEnv, node, "self", unknown("parameter", { parameter: "self" }), depth + 1, true, true);
        for (const parameter of names) bind(bodyEnv, parameter, parameter.text, unknown("parameter", { parameter: short(parameter.text), functionId: fact.id }), depth + 1, true, true);
        block(field(node, "body"), bodyEnv, depth + 1, false);
        return fact;
      }
      function call(node, env, depth) {
        if (callCache.has(node.id)) return callCache.get(node.id);
        const name = field(node, "name");
        const callee = expression(name, env, depth);
        const argumentsNodes = named(field(node, "arguments"));
        const argumentsOrigins = argumentsNodes.map((argument) => ({ span: location(argument), origin: expression(argument, env, depth) }));
        const target = terminal(callee);
        const method = name?.type === "method_index_expression" ? short(field(name, "method")?.text ?? "") : null;
        const fact = add("calls", { ...base(node, "call"), callee: name?.type === "identifier" ? short(name.text) : method ?? (field(name, "field")?.type === "identifier" ? short(field(name, "field").text) : "<expression>"), calleeOrigin: callee, ...(method ? { method, receiverIdentity: "unverified" } : {}), ...(target.kind === "function" ? { targetFunctionId: target.functionId } : {}), confidence: target.kind === "function" ? "inferred" : "unresolved", arguments: argumentsOrigins.slice(0, ANALYSIS_LIMITS.maxArguments), argumentCount: argumentsNodes.length, argumentsTruncated: argumentsNodes.length > ANALYSIS_LIMITS.maxArguments, snippet: snippet(node) });
        callCache.set(node.id, fact);
        if (target.kind === "builtin" && target.name === "require" && !environmentUncertain) dependency(node, argumentsNodes[0], argumentsOrigins[0]?.origin ?? unknown("missing-argument"), fact);
        if (name?.type === "identifier" && ["getfenv", "setfenv", "loadstring", "load", "rawset"].includes(name.text) && !lookup(env, name.text)) {
          environmentUncertain = true;
          diagnostic(module, "ENVIRONMENT_EFFECT", node, "Reflective or environment effects are not resolved");
        }
        chargeScope(capturedWrites.size);
        for (const captured of capturedWrites) {
          const existing = lookup(env, captured);
          if (!existing || existing.entry.depth === depth) bind(env, node, captured, unknown("possible-captured-write", { callsiteId: fact.id }), depth);
        }
        return fact;
      }
      function expression(node, env, depth, hint) {
        visitSemantic();
        if (!node) return { kind: "literal", literalType: "nil", confidence: "direct" };
        switch (node.type) {
          case "identifier": return reference(env, node, depth);
          case "number": case "string": case "true": case "false": case "nil":
            for (const child of named(node)) if (child.type === "interpolation") for (const value of named(child)) expression(value, env, depth);
            if (named(node).some((child) => child.type === "interpolation")) return unknown("interpolated-string");
            return { kind: "literal", literalType: node.type, confidence: "direct" };
          case "parenthesized_expression": case "cast_expression": return expression(named(node)[0], env, depth, hint);
          case "dot_index_expression": case "method_index_expression": case "bracket_index_expression": return member(node, env, depth);
          case "function_definition": { const fn = analyzeFunction(node, env, depth, hint); return { kind: "function", functionId: fn.id, confidence: "direct" }; }
          case "function_call": return unknown("return-derived", { callsiteId: call(node, env, depth).id });
          case "vararg_expression": return unknown("varargs");
          case "table_constructor":
            for (const entry of named(node)) for (const child of named(entry)) expression(child, env, depth);
            return { kind: "table", confidence: "direct", reason: "table-members-not-resolved" };
          case "if_expression":
            for (const child of named(node)) expression(child, env, depth);
            return unknown("branch-merge");
          default:
            for (const child of named(node)) expression(child, env, depth);
            return unknown(node.type === "binary_expression" || node.type === "unary_expression" ? "computed-expression" : "unsupported-expression", { syntax: short(node.type) });
        }
      }
      function assignment(node, env, depth, local = false) {
        const assignmentNode = node.type === "variable_declaration" ? named(node)[0] : node;
        const variables = assignmentNode?.type === "variable_list" ? assignmentNode : named(assignmentNode).find((child) => child.type === "variable_list");
        const targets = variables?.childrenForFieldName("name") ?? [];
        const values = named(named(assignmentNode).find((child) => child.type === "expression_list"));
        // Luau evaluates computed assignment targets before committing any target
        // binding, so an earlier target cannot change a later target's index origin.
        for (const target of targets) if (target.type !== "identifier") expression(target, env, depth);
        const origins = values.map((value, index) => expression(value, env, depth, functionDisplayName(targets[index])));
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index];
          let origin = origins[index] ?? (values.at(-1)?.type === "function_call" || values.at(-1)?.type === "vararg_expression" ? unknown("multiple-return", { resultIndex: index - values.length + 2 }) : { kind: "literal", literalType: "nil", confidence: "direct" });
          if (node.type === "update_statement") origin = unknown("update-assignment", { previous: target.type === "identifier" ? reference(env, target, depth) : unknown("member-write") });
          if (target.type === "identifier") bind(env, target, target.text, origin, depth, local, local);
          else diagnostic(module, "MEMBER_WRITE", target, "Member writes are not tracked as stable value identities");
        }
      }
      function merge(env, alternatives, node, depth, reason) {
        for (let index = 0; index < env.length; index += 1) {
          chargeScope(env[index].size + alternatives.reduce((count, alternative) => count + alternative[index].size, 0));
          const keys = new Set([...env[index].keys(), ...alternatives.flatMap((alternative) => [...alternative[index].keys()])]);
          chargeScope(keys.size * alternatives.length);
          for (const key of keys) {
            const original = env[index].get(key)?.fact.id;
            if (alternatives.some((alternative) => alternative[index].get(key)?.fact.id !== original)) bind(env, node, key, unknown(reason), depth, false);
          }
        }
      }
      function statement(node, env, depth) {
        visitSemantic();
        if (ignoredTypes.has(node.type)) return;
        switch (node.type) {
          case "variable_declaration": return assignment(node, env, depth, true);
          case "assignment_statement": case "update_statement": return assignment(node, env, depth);
          case "function_call": call(node, env, depth); return;
          case "function_declaration": {
            const name = field(node, "name");
            const local = node.children.some((child) => !child.isNamed && child.type === "local");
            const placeholder = name?.type === "identifier" ? bind(env, name, name.text, unknown("function-initialization"), depth, local, true) : null;
            const fn = analyzeFunction(node, env, depth, functionDisplayName(name));
            if (placeholder) bind(env, name, name.text, { kind: "function", functionId: fn.id, confidence: "direct" }, depth);
            else { expression(name, env, depth); diagnostic(module, "MEMBER_FUNCTION", node, "Member function identity is not resolved through table mutation"); }
            return;
          }
          case "do_statement": block(field(node, "body") ?? named(node).find((child) => child.type === "block"), env, depth); return;
          case "if_statement": {
            expression(field(node, "condition"), env, depth);
            const alternatives = [];
            const first = clone(env);
            block(field(node, "consequence"), first, depth);
            alternatives.push(first);
            for (const alternative of node.childrenForFieldName("alternative")) {
              const branch = clone(env);
              if (field(alternative, "condition")) expression(field(alternative, "condition"), branch, depth);
              block(field(alternative, "consequence") ?? field(alternative, "body"), branch, depth);
              alternatives.push(branch);
            }
            merge(env, alternatives, node, depth, "branch-merge");
            return;
          }
          case "for_statement": case "while_statement": case "repeat_statement": {
            const loop = [...clone(env), new Map()];
            const clause = field(node, "clause");
            if (clause?.type === "for_numeric_clause") {
              for (const key of ["start", "end", "step"]) if (field(clause, key)) expression(field(clause, key), loop, depth);
              const name = field(clause, "name");
              bind(loop, name, name.text, unknown("loop-variable"), depth, true, true);
            } else if (clause) {
              for (const value of named(named(clause).find((child) => child.type === "expression_list"))) expression(value, loop, depth);
              const variables = named(clause).find((child) => child.type === "variable_list");
              for (const name of variables?.childrenForFieldName("name") ?? []) bind(loop, name, name.text, unknown("loop-variable"), depth, true, true);
            }
            // A callsite in a loop is not restricted to its first iteration. Mark
            // potentially loop-carried bindings before recording body/condition facts.
            const writes = new Set();
            function scanWrites(child, locals) {
              if (!child) return;
              state.nodes += 1;
              if (state.nodes > ANALYSIS_LIMITS.maxNodes) { state.truncated = true; throw budgetStop; }
              if (child.type === "function_definition") return;
              if (child.type === "function_declaration") {
                const name = field(child, "name");
                const local = child.children.some((value) => !value.isNamed && value.type === "local");
                if (name?.type === "identifier") {
                  if (local) locals.add(name.text); else if (!locals.has(name.text)) writes.add(name.text);
                }
                return;
              }
              if (child.type === "variable_declaration") {
                const assignment = named(child)[0];
                const variables = assignment?.type === "variable_list" ? assignment : named(assignment).find((value) => value.type === "variable_list");
                for (const value of named(assignment).filter((value) => value.type === "expression_list")) scanWrites(value, locals);
                for (const name of variables?.childrenForFieldName("name") ?? []) if (name.type === "identifier") locals.add(name.text);
                return;
              }
              if (child.type === "block") {
                chargeScope(locals.size);
                const inner = new Set(locals);
                for (const value of named(child)) scanWrites(value, inner);
                return;
              }
              if (child.type === "for_statement") {
                const nestedClause = field(child, "clause");
                scanWrites(nestedClause, locals);
                chargeScope(locals.size);
                const inner = new Set(locals);
                const variables = named(nestedClause).find((value) => value.type === "variable_list");
                for (const name of variables?.childrenForFieldName("name") ?? []) if (name.type === "identifier") inner.add(name.text);
                const name = field(nestedClause, "name");
                if (name?.type === "identifier") inner.add(name.text);
                scanWrites(field(child, "body"), inner);
                return;
              }
              if (child.type === "assignment_statement" || child.type === "update_statement") {
                const variables = named(child).find((value) => value.type === "variable_list");
                for (const name of variables?.childrenForFieldName("name") ?? []) if (name.type === "identifier" && !locals.has(name.text)) writes.add(name.text);
              }
              if (child.type === "function_call") {
                chargeScope(capturedWrites.size);
                for (const name of capturedWrites) if (!locals.has(name)) writes.add(name);
              }
              for (const value of named(child)) scanWrites(value, locals);
            }
            chargeScope(loop.at(-1).size);
            const loopLocals = new Set(loop.at(-1).keys());
            scanWrites(field(node, "body"), loopLocals);
            scanWrites(field(node, "condition"), loopLocals);
            for (const name of writes) bind(loop, node, name, unknown("loop-carried"), depth);
            if (node.type === "while_statement") expression(field(node, "condition"), loop, depth);
            block(field(node, "body"), loop, depth, false);
            if (node.type === "repeat_statement") expression(field(node, "condition"), loop, depth);
            loop.pop();
            merge(env, [loop], node, depth, "loop-merge");
            return;
          }
          case "return_statement": for (const child of named(node)) expression(child, env, depth); return;
          default: diagnostic(module, "UNSUPPORTED_SYNTAX", node, `Statement analysis is unavailable for ${short(node.type)}`);
        }
      }
      function block(node, env, depth, ownScope = true) {
        if (!node) return;
        if (ownScope) env.push(new Map());
        try { for (const child of named(node)) statement(child, env, depth); }
        finally { if (ownScope) env.pop(); }
      }
      block(root, [new Map()], 0, false);
    } catch (error) {
      if (error !== budgetStop) throw error;
      file.truncated = true;
      diagnostic(module, "ANALYSIS_LIMIT", null, "AST, semantic, fact or scope-work analysis limit reached");
    } finally {
      file.facts = state.facts - initialFacts;
      file.diagnostics = diagnostics.length - initialDiagnostics;
      file.complete = !file.parseErrors && !file.truncated;
    }
  }
  return { parser, files, facts, diagnostics, truncated: state.truncated, budgets: { ...ANALYSIS_LIMITS, nodes: state.nodes, facts: state.facts, scopeWork: state.scopeWork, semanticVisits: state.semanticVisits, factBytesUpperBound: state.factBytes, diagnosticsDropped: state.diagnosticsDropped, positionEncoding: "utf16", lineBase: 1, columnBase: 1 }, completeness: { syntax: files.every((file) => !file.parseErrors), bounded: !state.truncated, semantic: "conservative", execution: "not-executed" } };
}
