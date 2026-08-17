import { describe, expect, it } from "vitest";
import { splitText } from "../src/lib/utils.js";

describe("splitText", () => {
  it("returns single chunk for short text", () => {
    expect(splitText("hello", 30000)).toEqual(["hello"]);
  });

  it("chunks overlong text to <= max", () => {
    const big = "x".repeat(70000);
    const chunks = splitText(big, 30000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30000);
    expect(chunks.join("")).toBe(big);
  });

  it("prefers splitting at newline near the limit", () => {
    const a = "a".repeat(100);
    const b = "b".repeat(100);
    const text = `${a}\n${b}`;
    const chunks = splitText(text, 102);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });
});
