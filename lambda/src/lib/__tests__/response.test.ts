import { describe, expect, it } from "vitest";
import { fail, ok } from "../response.js";

describe("ok", () => {
  it("wraps the data in a success envelope with status 200 by default", () => {
    // Act
    const result = ok({ id: 1 });

    // Assert
    expect(result).toEqual({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, data: { id: 1 } }),
    });
  });

  it("uses the given status code", () => {
    expect(ok(null, 201)).toMatchObject({ statusCode: 201 });
  });
});

describe("fail", () => {
  it("returns only the message when there are no field errors", () => {
    const result = fail(404, "見つかりません。");

    expect(result).toMatchObject({ statusCode: 404 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      ok: false,
      error: { message: "見つかりません。" },
    });
  });

  it("includes field errors for validation failures", () => {
    const result = fail(400, "入力に誤りがあります。", { word: ["必須です。"] });

    expect(JSON.parse((result as { body: string }).body)).toEqual({
      ok: false,
      error: { message: "入力に誤りがあります。", fields: { word: ["必須です。"] } },
    });
  });
});
