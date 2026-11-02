import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
// Bare calls are allowed only when a lexical binding supplies the callback.
function nativeCalls(source: string): string[] {
  const violations: string[] = [];
  function names(node: any): string[] {
    if (!node) return [];
    if (node.type === 'Identifier') return [node.name];
    if (node.type === 'AssignmentPattern') return names(node.left);
    if (node.type === 'RestElement') return names(node.argument);
    if (node.type === 'ObjectPattern') return node.properties.flatMap((property: any) => names(property.value ?? property.argument));
    if (node.type === 'ArrayPattern') return node.elements.flatMap(names);
    return [];
  }
  function visit(node: any, bindings: string[]) {
    if (!node || typeof node !== 'object') return;
    const local = [...bindings];
    if (node.params) local.push(...node.params.flatMap(names));
    if (['Program', 'BlockStatement'].includes(node.type)) {
      for (const statement of node.body) {
        const declaration = statement.declaration ?? statement;
        if (declaration.type === 'VariableDeclaration') local.push(...declaration.declarations.flatMap((item: any) => names(item.id)));
        if (declaration.type === 'FunctionDeclaration') local.push(...names(declaration.id));
        if (declaration.type === 'ImportDeclaration') local.push(...declaration.specifiers.flatMap((item: any) => names(item.local)));
      }
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = node.callee;
      if (callee.type === 'Identifier' && /^(confirm|alert|prompt)$/.test(callee.name) && !local.includes(callee.name)) violations.push(callee.name);
      if (callee.type === 'MemberExpression' && ['window', 'globalThis', 'self'].includes(callee.object.name) && /^(confirm|alert|prompt)$/.test(callee.property.name ?? callee.property.value)) violations.push(`${callee.object.name}.${callee.property.name ?? callee.property.value}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, local));
      else if (value && typeof value === 'object') visit(value, local);
    }
  }
  visit(parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }).program, []);
  return violations;
}

test('dialog guard rejects bare globals while allowing injected dialog callbacks', () => {
  expect(nativeCalls('confirm("global"); alert("global"); prompt("global"); window.confirm("global"); function local(confirm: () => void) { confirm(); }')).toEqual(['confirm', 'alert', 'prompt', 'window.confirm']);
  expect(nativeCalls('function local(confirm: () => void) { confirm(); } confirm("outside");')).toEqual(['confirm']);
});

test('app source never uses native browser dialogs (unavailable in desktop webviews)', () => {
  const paths = files('app/src').filter(path => /\.[jt]sx?$/.test(path));
  const violations = paths.flatMap(path => nativeCalls(readFileSync(path, 'utf8')).map(call => `${path}: ${call}`));
  expect(violations).toEqual([]);
  expect(files('desktop/ui').filter(path => /window\s*\.\s*(confirm|prompt|alert)\b|(?<![\w.])(?:confirm|alert|prompt)\s*\(/.test(readFileSync(path, 'utf8')))).toEqual([]);
});
