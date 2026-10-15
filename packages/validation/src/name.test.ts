import { describe, expect, test } from "vitest";
import { nameMatchScore, normaliseName } from "./name.js";

describe("normaliseName", () => {
  test("uppercases and collapses whitespace", () => {
    expect(normaliseName("  ramesh   kumar  sharma ")).toBe("RAMESH KUMAR SHARMA");
  });

  test("removes dots from initials", () => {
    expect(normaliseName("R.K. Sharma")).toBe("R K SHARMA");
  });

  test("strips honorifics", () => {
    expect(normaliseName("Shri Ramesh Kumar Sharma")).toBe("RAMESH KUMAR SHARMA");
    expect(normaliseName("Smt. Lakshmi Devi Yadav")).toBe("LAKSHMI DEVI YADAV");
    expect(normaliseName("Dr Nikhil Desai")).toBe("NIKHIL DESAI");
    expect(normaliseName("LATE MOHAN LAL SHARMA")).toBe("MOHAN LAL SHARMA");
  });

  test("strips relationship prefixes found on land records", () => {
    expect(normaliseName("Ramesh Kumar Sharma S/O Mohan Lal")).toBe(
      "RAMESH KUMAR SHARMA MOHAN LAL",
    );
  });

  test("does not strip a name that merely starts with an honorific's letters", () => {
    // "DRISHTI" begins with "DR" but is not Dr. anybody.
    expect(normaliseName("Drishti Sharma")).toBe("DRISHTI SHARMA");
  });

  test("removes hyphens and commas", () => {
    expect(normaliseName("Sharma, Ramesh-Kumar")).toBe("SHARMA RAMESH KUMAR");
  });
});

/**
 * The score feeds core.decideKyc(). Tests assert bands rather than exact
 * decimals, so tuning the algorithm does not break the suite — what must hold
 * is which band a real-world pair lands in.
 *
 * Starting threshold is 0.75, held in the settings table.
 */
describe("nameMatchScore", () => {
  test("an exact match scores 1", () => {
    expect(nameMatchScore("Ramesh Kumar Sharma", "RAMESH KUMAR SHARMA")).toBe(1);
  });

  test("is symmetric", () => {
    const a = nameMatchScore("Priya Nair", "Priya Menon");
    const b = nameMatchScore("Priya Menon", "Priya Nair");
    expect(a).toBe(b);
  });

  test("initials expand to the full name and pass", () => {
    const score = nameMatchScore("Ramesh Kumar Sharma", "R K Sharma");
    expect(score).toBeGreaterThanOrEqual(0.75);
    expect(score).toBeLessThan(1);
  });

  test("word order does not matter", () => {
    expect(nameMatchScore("Sharma Ramesh Kumar", "Ramesh Kumar Sharma")).toBe(1);
  });

  test("a dropped middle name still passes", () => {
    expect(nameMatchScore("Ramesh Kumar Sharma", "Ramesh Sharma")).toBeGreaterThanOrEqual(
      0.75,
    );
  });

  test("a spelling variant of a surname still passes", () => {
    expect(nameMatchScore("Anil Guptha", "Anil Gupta")).toBeGreaterThanOrEqual(0.75);
  });

  test("a changed surname lands in the review band, not auto-pass", () => {
    const score = nameMatchScore("Priya Nair", "Priya Menon");
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.75);
  });

  test("only a first name in common does not auto-pass", () => {
    expect(nameMatchScore("Ramesh", "Ramesh Kumar Sharma")).toBeLessThan(0.75);
  });

  test("two different people score low", () => {
    expect(nameMatchScore("Ramesh Kumar Sharma", "Anita Desai")).toBeLessThan(0.4);
  });

  test("an empty name scores 0 rather than throwing", () => {
    expect(nameMatchScore("", "Ramesh Sharma")).toBe(0);
    expect(nameMatchScore("Ramesh Sharma", "   ")).toBe(0);
  });
});
