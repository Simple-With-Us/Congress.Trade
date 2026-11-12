import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOGO_SOURCE_ORDER,
  SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER,
  canonicalLogoPolicySymbol,
  policyFromLetters,
  remoteLogoSources,
  sourceOrderFor,
} from "../tickerLogoPolicy";

describe("canonicalLogoPolicySymbol", () => {
  it("maps Berkshire aliases to BRK-B", () => {
    expect(canonicalLogoPolicySymbol("brk.b")).toBe("BRK-B");
    expect(canonicalLogoPolicySymbol("BRKB")).toBe("BRK-B");
  });
});

describe("policyFromLetters", () => {
  it("maps CD to logo.dev on both themes", () => {
    expect(policyFromLetters("CD")).toEqual({
      light: ["logodev", "local"],
      dark: ["logodev", "local"],
    });
  });

  it("maps BCD to logo.dev on light and GitHub-first on dark", () => {
    const p = policyFromLetters("BCD");
    expect(p?.light).toEqual(["logodev", "local"]);
    expect(p?.dark[0]).toBe("github");
  });
});

describe("sourceOrderFor", () => {
  it("uses logo.dev-first default for ungraded ABCD tickers", () => {
    expect(sourceOrderFor("GOOGL", "dark")).toEqual([...DEFAULT_LOGO_SOURCE_ORDER]);
    expect(sourceOrderFor("MSFT", "light")[0]).toBe("github");
  });

  it("accepts an ST GitHub-first fallback for ungraded names", () => {
    expect(sourceOrderFor("XYZ", "dark", undefined, SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER)).toEqual([
      "github",
      "logodev",
    ]);
  });

  it("pins AAPL light to logo.dev and dark to GitHub first", () => {
    expect(sourceOrderFor("AAPL", "light")[0]).toBe("logodev");
    expect(sourceOrderFor("AAPL", "dark")[0]).toBe("github");
  });

  it("drops GitHub for BRK-B", () => {
    expect(sourceOrderFor("BRK.B", "light")).not.toContain("github");
    expect(sourceOrderFor("BRK-B", "dark")).not.toContain("github");
  });

  it("lets overlay win over the seed", () => {
    expect(
      sourceOrderFor("AAPL", "dark", { AAPL: { light: ["logodev"], dark: ["logodev"] } }),
    ).toEqual(["logodev"]);
  });
});

describe("remoteLogoSources", () => {
  it("strips local for fetch-only apps", () => {
    expect(remoteLogoSources(["local", "github", "logodev"])).toEqual(["github", "logodev"]);
  });
});
