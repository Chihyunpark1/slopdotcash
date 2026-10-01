/** Proves a pasted github.com link becomes owner/name and nothing else is guessed. */
import { describe, expect, it } from "vitest";
import {
  normalizeRepositoryInput,
  validRepositoryPath,
} from "./project-proposal";

describe("proposal repository input", () => {
  it.each([
    ["https://github.com/modarresi1913/NurosOS", "modarresi1913/NurosOS"],
    ["http://www.github.com/example/repo/", "example/repo"],
    ["github.com/example/repo.git", "example/repo"],
    ["https://github.com/example/repo/tree/main/src", "example/repo"],
    ["https://github.com/example/repo?tab=readme-ov-file", "example/repo"],
    ["https://github.com/example/repo#readme", "example/repo"],
    ["git@github.com:example/repo.git", "example/repo"],
    ["ssh://git@github.com/example/repo", "example/repo"],
    ["  example/repo  ", "example/repo"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeRepositoryInput(input)).toBe(expected);
    expect(validRepositoryPath(normalizeRepositoryInput(input))).toBe(true);
  });

  it.each([
    "https://github.com/https://github.com/modarresi1913/NurosOS",
    "https://gitlab.com/example/repo",
    "https://github.com/example",
    "https://github.com/",
    "example",
    "example/repo/extra",
  ])("leaves %s visible and invalid", (input) => {
    expect(normalizeRepositoryInput(input)).toBe(input);
    expect(validRepositoryPath(input)).toBe(false);
  });
});
