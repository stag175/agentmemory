import { describe, expect, it } from "vitest";

import {
  iiiReleaseAssetFor,
  iiiReleaseChecksumAssetName,
  iiiReleaseChecksumUrlFor,
  iiiReleaseUrlFor,
} from "../src/cli/iii-release.js";

describe("iii release asset helpers", () => {
  it("maps supported platforms to the pinned iii engine archive names", () => {
    expect(iiiReleaseAssetFor("win32", "x64")).toBe(
      "iii-x86_64-pc-windows-msvc.zip",
    );
    expect(iiiReleaseAssetFor("linux", "x64")).toBe(
      "iii-x86_64-unknown-linux-gnu.tar.gz",
    );
    expect(iiiReleaseAssetFor("darwin", "arm64")).toBe(
      "iii-aarch64-apple-darwin.tar.gz",
    );
  });

  it("uses release checksum sidecars without archive suffixes", () => {
    expect(
      iiiReleaseChecksumAssetName("iii-x86_64-pc-windows-msvc.zip"),
    ).toBe("iii-x86_64-pc-windows-msvc.sha256");
    expect(
      iiiReleaseChecksumAssetName("iii-x86_64-unknown-linux-gnu.tar.gz"),
    ).toBe("iii-x86_64-unknown-linux-gnu.sha256");
  });

  it("builds release asset and checksum URLs for GitHub's tag layout", () => {
    expect(
      iiiReleaseUrlFor("0.11.2", "iii-x86_64-pc-windows-msvc.zip"),
    ).toBe(
      "https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-x86_64-pc-windows-msvc.zip",
    );
    expect(
      iiiReleaseChecksumUrlFor("0.11.2", "iii-x86_64-pc-windows-msvc.zip"),
    ).toBe(
      "https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-x86_64-pc-windows-msvc.sha256",
    );
  });
});
