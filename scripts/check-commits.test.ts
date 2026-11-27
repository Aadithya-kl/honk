import { expect, test } from "bun:test";
import { subjectProblem, TYPES } from "./check-commits.ts";

test("every listed type is accepted", () => {
  for (const type of TYPES) expect(subjectProblem(`${type}: something`)).toBeNull();
});

test("a scope and a breaking-change mark are accepted", () => {
  expect(subjectProblem("build(deps): bump @opentui/core from 0.9.8 to 0.9.9")).toBeNull();
  expect(subjectProblem("feat!: rename the config key theme to colors")).toBeNull();
  expect(subjectProblem("chore(main): release 0.2.0")).toBeNull();
});

test("a subject without a type is refused", () => {
  expect(subjectProblem("Add a bug report form")).toStartWith("the subject must start with a type");
});

test("an unknown type is named", () => {
  expect(subjectProblem("feature: connect to several servers")).toStartWith('"feature" is not a type');
});

test("the colon needs a space and a description after it", () => {
  expect(subjectProblem("fix:no space")).not.toBeNull();
  expect(subjectProblem("fix: ")).not.toBeNull();
});
