import { describe, it, expect, beforeAll } from "vitest";

let fileTransferResolvers;
let verifyOwnerDownloadToken;

const TRANSFER_ID = "651111111111111111111111";
const OWNER_ID = "652222222222222222222222";
const OTHER_ID = "653333333333333333333333";

describe("FileTransfer.ownerDownloadToken", () => {
  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET =
      process.env.BETTER_AUTH_SECRET || "test-secret";
    fileTransferResolvers = (
      await import("../../src/resolvers/fileTransfer.js")
    ).default;
    ({ verifyOwnerDownloadToken } =
      await import("../../src/utils/ownerDownloadToken.js"));
  });

  const resolve = (transfer, user) =>
    fileTransferResolvers.FileTransfer.ownerDownloadToken(
      transfer,
      {},
      {
        user,
      },
    );

  it("émet un jeton vérifiable pour le propriétaire authentifié", () => {
    const token = resolve(
      { _id: TRANSFER_ID, userId: OWNER_ID },
      { id: OWNER_ID },
    );

    expect(token).toBeTruthy();
    expect(verifyOwnerDownloadToken(token, TRANSFER_ID, OWNER_ID)).toBe(true);
  });

  it("n'émet rien pour un autre utilisateur ni pour un visiteur anonyme", () => {
    const transfer = { _id: TRANSFER_ID, userId: OWNER_ID };

    expect(resolve(transfer, { id: OTHER_ID })).toBeNull();
    expect(resolve(transfer, null)).toBeNull();
  });

  it("émet un jeton inutilisable sur un autre transfert", () => {
    const token = resolve(
      { _id: TRANSFER_ID, userId: OWNER_ID },
      { id: OWNER_ID },
    );

    expect(
      verifyOwnerDownloadToken(token, "659999999999999999999999", OWNER_ID),
    ).toBe(false);
  });
});
