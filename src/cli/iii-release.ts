import { platform } from "node:os";

export function iiiReleaseAssetFor(
  nodePlatform: NodeJS.Platform,
  arch: string,
): string | null {
  if (nodePlatform === "darwin" && arch === "arm64")
    return "iii-aarch64-apple-darwin.tar.gz";
  if (nodePlatform === "darwin" && arch === "x64")
    return "iii-x86_64-apple-darwin.tar.gz";
  if (nodePlatform === "linux" && arch === "x64")
    return "iii-x86_64-unknown-linux-gnu.tar.gz";
  if (nodePlatform === "linux" && arch === "arm64")
    return "iii-aarch64-unknown-linux-gnu.tar.gz";
  if (nodePlatform === "linux" && arch === "arm")
    return "iii-armv7-unknown-linux-gnueabihf.tar.gz";
  if (nodePlatform === "win32" && arch === "x64")
    return "iii-x86_64-pc-windows-msvc.zip";
  if (nodePlatform === "win32" && arch === "arm64")
    return "iii-aarch64-pc-windows-msvc.zip";
  return null;
}

export function iiiReleaseAsset(): string | null {
  return iiiReleaseAssetFor(platform(), process.arch);
}

export function iiiReleaseUrlFor(version: string, asset: string): string {
  return `https://github.com/iii-hq/iii/releases/download/iii/v${version}/${asset}`;
}

export function iiiReleaseChecksumAssetName(asset: string): string {
  if (asset.endsWith(".tar.gz")) return `${asset.slice(0, -".tar.gz".length)}.sha256`;
  if (asset.endsWith(".zip")) return `${asset.slice(0, -".zip".length)}.sha256`;
  return `${asset}.sha256`;
}

export function iiiReleaseChecksumUrlFor(
  version: string,
  asset: string,
): string {
  return iiiReleaseUrlFor(version, iiiReleaseChecksumAssetName(asset));
}
