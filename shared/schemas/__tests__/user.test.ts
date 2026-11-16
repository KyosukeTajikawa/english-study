import { describe, expect, it } from "vitest";
import { userProfileSchema } from "../user";

describe("userProfileSchema", () => {
  it("drops keys that are not part of the profile so DB columns never reach the browser", () => {
    // Arrange
    const row = {
      id: "user-1",
      email: "learner@example.com",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
      createdAt: new Date(),
    };

    // Act
    const profile = userProfileSchema.parse(row);

    // Assert
    expect(profile).toEqual({
      email: "learner@example.com",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
    });
  });

  it("rejects a profile whose email is not an email address", () => {
    const result = userProfileSchema.safeParse({
      email: "not-an-email",
      timezone: "Asia/Tokyo",
      notificationTime: "07:00",
    });

    expect(result.success).toBe(false);
  });
});
