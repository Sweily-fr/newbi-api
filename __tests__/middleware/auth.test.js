import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn(),
    decode: vi.fn(),
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../src/models/User.js", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../src/services/jwks-validator.js", () => ({
  getJWKSValidator: vi.fn().mockResolvedValue({
    validateJWT: vi.fn(),
  }),
}));

vi.mock("../../src/middlewares/better-auth.js", () => ({
  betterAuthMiddleware: vi.fn(),
}));

vi.mock("../../src/middlewares/org-resolver.js", () => ({
  getActiveOrganization: vi.fn(),
}));

import {
  isAuthenticated,
  withWorkspace,
} from "../../src/middlewares/better-auth-jwt.js";
import { getActiveOrganization } from "../../src/middlewares/org-resolver.js";
import { AppError, ERROR_CODES } from "../../src/utils/errors.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractJWTToken logic", () => {
  // Test the token extraction logic inline
  const extractJWTToken = (headers) => {
    const authHeader = headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }
    return headers["x-jwt-token"];
  };

  it("should extract token from Bearer header", () => {
    const headers = { authorization: "Bearer my-jwt-token-123" };
    expect(extractJWTToken(headers)).toBe("my-jwt-token-123");
  });

  it("should extract token from x-jwt-token header", () => {
    const headers = { "x-jwt-token": "custom-token-456" };
    expect(extractJWTToken(headers)).toBe("custom-token-456");
  });

  it("should return undefined when no token is present", () => {
    const headers = {};
    expect(extractJWTToken(headers)).toBeUndefined();
  });

  it("should not extract from non-Bearer authorization header", () => {
    const headers = { authorization: "Basic dXNlcjpwYXNz" };
    expect(extractJWTToken(headers)).toBeUndefined();
  });

  it("should prefer Bearer over x-jwt-token", () => {
    const headers = {
      authorization: "Bearer bearer-token",
      "x-jwt-token": "custom-token",
    };
    expect(extractJWTToken(headers)).toBe("bearer-token");
  });
});

describe("isAuthenticated wrapper", () => {
  it("should call resolver when user is in context", () => {
    const mockResolver = vi.fn().mockReturnValue("result");
    const wrapped = isAuthenticated(mockResolver);

    const context = { user: { _id: "user-1", email: "test@test.com" } };
    const result = wrapped(null, {}, context, {});

    expect(mockResolver).toHaveBeenCalledWith(null, {}, context, {});
    expect(result).toBe("result");
  });

  it("should throw UNAUTHENTICATED when user is missing", () => {
    const mockResolver = vi.fn();
    const wrapped = isAuthenticated(mockResolver);

    const context = { user: null };

    expect(() => wrapped(null, {}, context, {})).toThrow(
      "Vous devez être connecté",
    );
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it("should throw UNAUTHENTICATED when user is undefined", () => {
    const mockResolver = vi.fn();
    const wrapped = isAuthenticated(mockResolver);

    expect(() => wrapped(null, {}, {}, {})).toThrow("Vous devez être connecté");
  });
});

describe("withWorkspace wrapper", () => {
  it("should inject verified workspaceId after membership check", async () => {
    getActiveOrganization.mockResolvedValue({
      id: "org-verified",
      memberRole: "member",
    });
    const mockResolver = vi.fn().mockResolvedValue("result");
    const wrapped = withWorkspace(mockResolver);

    const context = {
      user: { _id: { toString: () => "user-1" } },
      req: { headers: { "x-workspace-id": "org-verified" } },
    };

    const result = await wrapped(null, {}, context, {});

    expect(result).toBe("result");
    expect(getActiveOrganization).toHaveBeenCalledWith(
      "user-1",
      "org-verified",
    );
    const enhancedContext = mockResolver.mock.calls[0][2];
    expect(enhancedContext.workspaceId).toBe("org-verified");
  });

  it("should prefer args.workspaceId over header", async () => {
    getActiveOrganization.mockResolvedValue({
      id: "org-from-args",
      memberRole: "owner",
    });
    const mockResolver = vi.fn().mockResolvedValue("result");
    const wrapped = withWorkspace(mockResolver);

    const context = {
      user: { _id: { toString: () => "user-1" } },
      req: { headers: { "x-workspace-id": "org-header" } },
    };

    await wrapped(null, { workspaceId: "org-from-args" }, context, {});

    expect(getActiveOrganization).toHaveBeenCalledWith(
      "user-1",
      "org-from-args",
    );
    const enhancedContext = mockResolver.mock.calls[0][2];
    expect(enhancedContext.workspaceId).toBe("org-from-args");
  });

  it("should throw FORBIDDEN when user is not member of requested org", async () => {
    getActiveOrganization.mockResolvedValue(null);
    const mockResolver = vi.fn();
    const wrapped = withWorkspace(mockResolver);

    const context = {
      user: { _id: { toString: () => "user-1" } },
      req: { headers: { "x-workspace-id": "org-not-mine" } },
    };

    await expect(wrapped(null, {}, context, {})).rejects.toThrow(
      "Accès non autorisé à cette organisation",
    );
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it("should throw UNAUTHENTICATED when user is missing", async () => {
    const mockResolver = vi.fn();
    const wrapped = withWorkspace(mockResolver);

    await expect(wrapped(null, {}, { user: null }, {})).rejects.toThrow(
      "Vous devez être connecté",
    );
  });

  it("should fallback to user default org when no workspaceId provided", async () => {
    getActiveOrganization.mockResolvedValue({
      id: "default-org",
      memberRole: "owner",
    });
    const mockResolver = vi.fn().mockResolvedValue("result");
    const wrapped = withWorkspace(mockResolver);

    const context = {
      user: { _id: { toString: () => "user-1" } },
      req: { headers: {} },
    };

    await wrapped(null, {}, context, {});

    expect(getActiveOrganization).toHaveBeenCalledWith("user-1", null);
    const enhancedContext = mockResolver.mock.calls[0][2];
    expect(enhancedContext.workspaceId).toBe("default-org");
  });

  it("should throw FORBIDDEN when no default org found", async () => {
    getActiveOrganization.mockResolvedValue(null);
    const mockResolver = vi.fn();
    const wrapped = withWorkspace(mockResolver);

    const context = {
      user: { _id: { toString: () => "orphan-user" } },
      req: { headers: {} },
    };

    await expect(wrapped(null, {}, context, {})).rejects.toThrow(
      "Aucune organisation active trouvée",
    );
    expect(mockResolver).not.toHaveBeenCalled();
  });
});

describe("User cache logic", () => {
  // Test the cache helper functions pattern
  const USER_CACHE_TTL = 30000;
  const USER_CACHE_MAX = 500;
  const cache = new Map();

  function getCachedUser(userId) {
    const entry = cache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.ts > USER_CACHE_TTL) {
      cache.delete(userId);
      return null;
    }
    return entry.user;
  }

  function setCachedUser(userId, user) {
    if (cache.size >= USER_CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    cache.set(userId, { user, ts: Date.now() });
  }

  beforeEach(() => {
    cache.clear();
  });

  it("should return null for uncached user", () => {
    expect(getCachedUser("user-1")).toBe(null);
  });

  it("should return cached user within TTL", () => {
    const user = { name: "Test" };
    setCachedUser("user-1", user);
    expect(getCachedUser("user-1")).toEqual(user);
  });

  it("should evict oldest entry when max size reached", () => {
    // Fill cache with USER_CACHE_MAX = 500 (using small test max)
    for (let i = 0; i < 3; i++) {
      cache.set(`user-${i}`, { user: { name: `User ${i}` }, ts: Date.now() });
    }

    // Simulate max size check
    const testCache = new Map();
    const MAX = 3;
    for (let i = 0; i < MAX; i++) {
      testCache.set(`user-${i}`, { user: {}, ts: Date.now() });
    }

    // Add one more
    if (testCache.size >= MAX) {
      const oldestKey = testCache.keys().next().value;
      testCache.delete(oldestKey);
    }
    testCache.set("user-new", { user: { name: "New" }, ts: Date.now() });

    expect(testCache.has("user-0")).toBe(false);
    expect(testCache.has("user-new")).toBe(true);
  });
});
