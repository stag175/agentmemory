import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("viewer Actions tab tolerates legacy scalar tags", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("normalizes array, scalar, and missing tags before search or render", () => {
    expect(viewer).toMatch(/function actionTags\(a\)/);
    expect(viewer).toMatch(/Array\.isArray\(a\.tags\)/);
    expect(viewer).toMatch(/typeof a\.tags === 'string'/);
    expect(viewer).toMatch(/actionTags\(a\)\.join\(' '\)/);
    expect(viewer).toMatch(/actionTags\(a\)\.map\(esc\)\.join\(', '\)/);
  });
});
