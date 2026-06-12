import { describe, expect, it } from "vitest";
import { generateJoinCode } from "../src/codes.js";

describe("generateJoinCode", () => {
  it("produces 6 chars from the unambiguous alphabet (no 0/O/1/I)", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateJoinCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});
