/**
 * Envois de transferts hérités (disque local, base64, morceaux GraphQL, URL
 * présignées) : inutilisés par le site et l'application, mais appelables
 * sans les contrôles du parcours actuel (durée, paiement, taille). Retirés :
 * un membre qui a le droit reçoit METHOD_RETIRED et rien n'est créé ; les
 * autres sont refusés comme avant.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const r2 = vi.hoisted(() => new Proxy({}, { get: () => vi.fn() }));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";
import chunkUploadResolvers from "../../src/resolvers/chunkUpload.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";
import { RETIRED_TRANSFER_UPLOADS } from "../../src/utils/retiredTransferUploads.js";

const RESOLVERS = {
  fileTransfer: fileTransferResolvers,
  chunkUpload: chunkUploadResolvers,
  chunkUploadR2: chunkUploadR2Resolvers,
};
const CASES = Object.entries(RETIRED_TRANSFER_UPLOADS).flatMap(
  ([file, names]) => names.map((name) => [name, file]),
);

let userId;
let workspace;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  userId = buildUserId();
  workspace = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId: workspace });
});

describe("Envois hérités retirés", () => {
  it.each(CASES)("%s : METHOD_RETIRED, rien n'est créé", async (name, file) => {
    let error = null;
    try {
      await RESOLVERS[file].Mutation[name](
        null,
        {
          fileIds: ["x"],
          files: [],
          input: { workspaceId: String(workspace) },
        },
        buildContext({ userId, organizationId: workspace }),
        { fieldName: name },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error?.extensions?.code || error?.code).toBe("METHOD_RETIRED");
    expect(await FileTransfer.countDocuments({})).toBe(0);
  });

  it("l'envoi actuel (multipart) reste disponible", () => {
    for (const name of [
      "startMultipartUpload",
      "completeMultipartUpload",
      "createFileTransferWithIdsR2",
    ]) {
      expect(Object.values(RETIRED_TRANSFER_UPLOADS).flat()).not.toContain(
        name,
      );
      expect(typeof chunkUploadR2Resolvers.Mutation[name]).toBe("function");
    }
  });
});
