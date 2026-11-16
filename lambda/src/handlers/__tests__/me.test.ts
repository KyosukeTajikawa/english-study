import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../router.js";

/**
 * GET /api/me のテスト。DB は getDb() を差し替えたフェイクで代用する。
 */

const upsert = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db.js", () => ({
  getDb: async () => ({ user: { upsert } }),
}));

const { handleMe } = await import("../me.js");

function createContext(email: string): RequestContext {
  return {
    method: "GET",
    path: "/api/me",
    headers: {},
    params: {},
    query: {},
    body: undefined,
    identity: { email },
  };
}

describe("handleMe", () => {
  it("returns the signed-in user's profile without the internal id", async () => {
    // Arrange
    upsert.mockResolvedValue({
      id: "user-1",
      email: "learner@example.com",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
    });

    // Act
    const result = await handleMe(createContext("learner@example.com"));

    // Assert
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      ok: true,
      data: { email: "learner@example.com", timezone: "Asia/Tokyo", notificationTime: "07:00" },
    });
  });

  it("looks the user up by the verified email only", async () => {
    upsert.mockResolvedValue({
      id: "user-2",
      email: "other@example.com",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
    });

    await handleMe(createContext("other@example.com"));

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "other@example.com" }, update: {} }),
    );
  });
});
