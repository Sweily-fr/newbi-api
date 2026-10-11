import { describe, it, expect, vi, beforeEach } from "vitest";

const OWN = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";

vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: vi.fn(async () => ({ _id: "user-1" })),
}));
vi.mock("../../src/utils/workspace-membership.js", () => ({
  // Membre de son seul espace ; un filtre { $ne: … } trouvait n'importe
  // quelle adhésion avant le correctif.
  userBelongsToWorkspace: vi.fn(
    async (_userId, workspaceId) =>
      workspaceId === OWN ||
      (typeof workspaceId === "object" && workspaceId !== null),
  ),
  userHasWorkspaceAction: vi.fn(async () => true),
  userHasWorkspaceLevel: vi.fn(async () => true),
}));

import { requireWorkspaceMembership } from "../../src/middlewares/require-workspace-membership.js";

const run = async ({ headers = {}, query = {}, body = {} }) => {
  const req = { headers: { ...headers }, query, body };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(function () {
      return this;
    }),
  };
  const next = vi.fn();
  await requireWorkspaceMembership(req, res, next);
  return { req, res, next };
};

// Les routes bancaires lisent `x-workspace-id || query.workspaceId`
// (ou `|| body.workspaceId`).
const handlerWorkspace = (req) =>
  req.headers["x-workspace-id"] ||
  req.query.workspaceId ||
  req.body.workspaceId;

describe("routes bancaires : espace validé par l'appartenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("x-organization-id = son espace et ?workspaceId=<autre> : le handler lit son espace", async () => {
    const { req, next } = await run({
      headers: { "x-organization-id": OWN },
      query: { workspaceId: OTHER },
    });
    expect(next).toHaveBeenCalled();
    expect(handlerWorkspace(req)).toBe(OWN);
    expect(req.workspaceId).toBe(OWN);
  });

  it("même chose avec l'espace dans le corps (déconnexion)", async () => {
    const { req, next } = await run({
      headers: { "x-organization-id": OWN },
      body: { workspaceId: OTHER },
    });
    expect(next).toHaveBeenCalled();
    expect(handlerWorkspace(req)).toBe(OWN);
  });

  it("?workspaceId[$ne]= sans en-tête : refusé", async () => {
    const { res, next } = await run({ query: { workspaceId: { $ne: null } } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("identifiant qui n'est pas un ObjectId : refusé", async () => {
    for (const workspaceId of ["abc", [OWN, OTHER], `${OWN} `]) {
      const { res, next } = await run({ query: { workspaceId } });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it("espace dont on n'est pas membre : refusé", async () => {
    const { res, next } = await run({ headers: { "x-workspace-id": OTHER } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("client normal (x-workspace-id = son espace) : inchangé", async () => {
    const { req, next } = await run({ headers: { "x-workspace-id": OWN } });
    expect(next).toHaveBeenCalled();
    expect(handlerWorkspace(req)).toBe(OWN);
  });
});
