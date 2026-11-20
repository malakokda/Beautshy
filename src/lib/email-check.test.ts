import { describe, expect, it } from "vitest";
import { isAllowedEmail, suggestEmail } from "./email-check";

describe("isAllowedEmail", () => {
  it("accepts only Gmail, Yahoo, iCloud and Hotmail", () => {
    for (const email of [
      "sara@gmail.com",
      "sara@yahoo.com",
      "sara@icloud.com",
      "Sara@Hotmail.com",
    ]) {
      expect(isAllowedEmail(email), email).toBe(true);
    }
    for (const email of [
      "sara@outlook.com",
      "sara@yahoo.com.eg",
      "sara@gmail.co",
      "sara@mail.gmail.com",
      "sara@cu.edu.eg",
      "@gmail.com",
      "not-an-email",
    ]) {
      expect(isAllowedEmail(email), email).toBe(false);
    }
  });
});

describe("suggestEmail", () => {
  it("corrects common misspellings of the allowed providers", () => {
    expect(suggestEmail("sara@gmial.com")).toBe("sara@gmail.com");
    expect(suggestEmail("sara@gmal.com")).toBe("sara@gmail.com");
    expect(suggestEmail("sara@hotmial.com")).toBe("sara@hotmail.com");
    expect(suggestEmail("sara@yaho.com")).toBe("sara@yahoo.com");
    expect(suggestEmail("sara@iclod.com")).toBe("sara@icloud.com");
  });

  it("corrects a mistyped .com ending", () => {
    expect(suggestEmail("sara@gmail.con")).toBe("sara@gmail.com");
    expect(suggestEmail("sara@gmail.co")).toBe("sara@gmail.com");
    expect(suggestEmail("sara@gmial.cmo")).toBe("sara@gmail.com");
    expect(suggestEmail("sara@icloud.cm")).toBe("sara@icloud.com");
  });

  it("keeps the part before @ exactly as typed", () => {
    expect(suggestEmail("Sara.Ali+shop@gmial.com")).toBe("Sara.Ali+shop@gmail.com");
  });

  it("suggests nothing for correct or unrelated addresses", () => {
    for (const email of [
      "sara@gmail.com",
      "sara@outlook.com",
      "sara@yahoo.com.eg",
      "sara@mail.com",
      "sara@gmx.com",
      "sara@cu.edu.eg",
      "not-an-email",
    ]) {
      expect(suggestEmail(email), email).toBeNull();
    }
  });
});
