import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, FrontmatterError } from "../../src/domain/retrieval/frontmatter.ts";

test("parses the restricted subset", () => assert.deepEqual(parseFrontmatter("---\nid: x\nservice: [a, b]\n---\n## S\nt").data, { id: "x", service: ["a", "b"] }));
test("returns the body after the closing fence", () => assert.equal(parseFrontmatter("---\nid: x\n---\n## S\nt").body, "## S\nt"));
test("rejects nested maps with the line number", () => assert.throws(() => parseFrontmatter("---\nid: x\nmeta: {a: 1}\n---\n"), (e) => e instanceof FrontmatterError && e.line === 3));
test("rejects indented lines", () => assert.throws(() => parseFrontmatter("---\nid: x\n  nested: y\n---\n"), (e) => e instanceof FrontmatterError && e.line === 3));
test("requires the closing fence", () => assert.throws(() => parseFrontmatter("---\nid: x\n## S"), FrontmatterError));
