import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import linkedinApi, {
  connectApp,
  escapeLittleText,
  scopes,
} from "../../../../src/services/social/direct/linkedinApi.js";
import storage from "../../../../src/services/social/socialMediaStorage.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import {
  callsTo,
  formOf,
  jsonOf,
  jsonResponse,
  on,
  sequence,
  stubFetch,
} from "./fetchStub.js";

const NOW = new Date("2026-11-02T08:00:00.000Z");
const person = {
  platform: "linkedin",
  externalAccountId: "urn:li:person:abc",
};
const organization = {
  platform: "linkedin",
  externalAccountId: "urn:li:organization:42",
};
const image = {
  url: "https://api.newbi.test/social-media/1.jpg",
  width: 1200,
  height: 627,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  timing.sleep = async () => {};
  process.env.LINKEDIN_CLIENT_ID = "li_client";
  process.env.LINKEDIN_CLIENT_SECRET = "li_secret";
  delete process.env.LINKEDIN_PAGES_CLIENT_ID;
  delete process.env.LINKEDIN_PAGES_CLIENT_SECRET;
  delete process.env.LINKEDIN_API_VERSION;
  vi.spyOn(storage, "fetchImage").mockResolvedValue({
    buffer: Buffer.from("jpeg"),
    contentType: "image/jpeg",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const usePagesApp = () => {
  process.env.LINKEDIN_PAGES_CLIENT_ID = "li_pages_client";
  process.env.LINKEDIN_PAGES_CLIENT_SECRET = "li_pages_secret";
};

describe("connexion", () => {
  it("permissions selon l'appli : profil seul, ou Community Management API dès qu'elle est posée", () => {
    expect(connectApp()).toBe("profile");
    expect(scopes()).toEqual(["openid", "profile", "w_member_social"]);
    usePagesApp();
    expect(connectApp()).toBe("pages");
    expect(scopes()).toEqual([
      "r_basicprofile",
      "w_member_social",
      "w_organization_social",
      "rw_organization_admin",
    ]);
    const url = new URL(
      linkedinApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: "https://api.newbi.test/social-connect/linkedin/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(url.searchParams.get("scope")).toBe(
      "r_basicprofile w_member_social w_organization_social rw_organization_admin",
    );
    expect(url.searchParams.get("client_id")).toBe("li_pages_client");
  });

  it("profil perso (OpenID Connect) : un compte, jeton de 60 jours", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/oauth/v2/accessToken",
        jsonResponse({
          access_token: "li_token",
          expires_in: 5184000,
          scope: "openid,profile,w_member_social",
        }),
      ),
      on(
        "GET",
        "/v2/userinfo",
        jsonResponse({
          sub: "abc",
          name: "Alice Martin",
          picture: "https://p",
        }),
      ),
    ]);
    const { accounts } = await linkedinApi.exchangeCode({
      code: "code",
      redirectUri: "https://api.newbi.test/social-connect/linkedin/callback",
      now: NOW,
    });
    expect(accounts).toEqual([
      expect.objectContaining({
        externalAccountId: "urn:li:person:abc",
        displayName: "Alice Martin",
        credentialGroup: "linkedin:urn:li:person:abc",
        platformData: { kind: "person", app: "profile" },
        credentials: expect.objectContaining({
          accessToken: "li_token",
          refreshToken: null,
          tokenExpiresAt: new Date(NOW.getTime() + 5184000 * 1000),
        }),
      }),
    ]);
    expect(
      formOf(callsTo(fetchMock, "POST", "/oauth/v2/accessToken")[0]),
    ).toMatchObject({
      grant_type: "authorization_code",
      client_secret: "li_secret",
    });
  });

  it("Community Management API : profil + pages où le membre peut publier", async () => {
    usePagesApp();
    const fetchMock = stubFetch([
      on(
        "POST",
        "/oauth/v2/accessToken",
        jsonResponse({
          access_token: "li_token",
          expires_in: 5184000,
          refresh_token: "li_refresh",
          refresh_token_expires_in: 31536000,
        }),
      ),
      on(
        "GET",
        "/v2/me",
        jsonResponse({
          id: "abc",
          localizedFirstName: "Alice",
          localizedLastName: "Martin",
        }),
      ),
      on(
        "GET",
        "/rest/organizationAcls",
        jsonResponse({
          elements: [
            { role: "ADMINISTRATOR", organization: "urn:li:organization:42" },
            {
              role: "CONTENT_ADMINISTRATOR",
              organizationTarget: "urn:li:organization:43",
            },
            // Analyste : ne peut pas publier
            { role: "ANALYST", organization: "urn:li:organization:44" },
          ],
        }),
      ),
      on(
        "GET",
        "/rest/organizations/42",
        jsonResponse({ localizedName: "Newbi", vanityName: "newbi" }),
      ),
      on(
        "GET",
        "/rest/organizations/43",
        jsonResponse({ status: 403, message: "ADMIN_ONLY" }, 403),
      ),
    ]);
    const { accounts } = await linkedinApi.exchangeCode({
      code: "code",
      redirectUri: "https://r",
      now: NOW,
    });
    expect(accounts.map((a) => [a.externalAccountId, a.displayName])).toEqual([
      ["urn:li:person:abc", "Alice Martin"],
      ["urn:li:organization:42", "Newbi"],
      ["urn:li:organization:43", "Page LinkedIn 43"],
    ]);
    expect(new Set(accounts.map((a) => a.credentialGroup)).size).toBe(1);
    expect(accounts.map((a) => a.platformData)).toEqual([
      { kind: "person", app: "pages" },
      { kind: "organization", app: "pages" },
      { kind: "organization", app: "pages" },
    ]);
    expect(
      formOf(callsTo(fetchMock, "POST", "/oauth/v2/accessToken")[0]),
    ).toMatchObject({
      client_id: "li_pages_client",
      client_secret: "li_pages_secret",
    });
    const acl = callsTo(fetchMock, "GET", "/rest/organizationAcls")[0];
    expect(acl[1].headers["Linkedin-Version"]).toBe("202610");
    expect(acl[1].headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  it("rafraîchissement : avec jeton de rafraîchissement, sinon reconnexion", async () => {
    stubFetch([
      on(
        "POST",
        "/oauth/v2/accessToken",
        jsonResponse({ access_token: "li_new", expires_in: 5184000 }),
      ),
    ]);
    const fresh = await linkedinApi.refreshCredentials({
      refreshToken: "li_refresh",
      now: NOW,
    });
    expect(fresh.accessToken).toBe("li_new");
    await expect(
      linkedinApi.refreshCredentials({ refreshToken: null }),
    ).rejects.toMatchObject({ authInvalid: true });

    stubFetch([
      on(
        "POST",
        "/oauth/v2/accessToken",
        jsonResponse(
          {
            error: "invalid_request",
            error_description:
              "The provided authorization grant or refresh token is invalid, expired or revoked",
          },
          400,
        ),
      ),
    ]);
    await expect(
      linkedinApi.refreshCredentials({ refreshToken: "revoked" }),
    ).rejects.toMatchObject({ authInvalid: true });
  });
});

describe("deux applis en même temps", () => {
  it("chaque compte rafraîchit son jeton avec l'appli qui l'a connecté", async () => {
    usePagesApp();
    const fetchMock = stubFetch([
      on(
        "POST",
        "/oauth/v2/accessToken",
        jsonResponse({ access_token: "li_new", expires_in: 5184000 }),
      ),
    ]);
    // Profil connecté avant la validation des pages (appli « profile »)
    await linkedinApi.refreshCredentials({
      account: { platformData: { kind: "person", app: "profile" } },
      refreshToken: "r1",
      now: NOW,
    });
    // Compte sans appli notée : le plus ancien cas, appli « profile »
    await linkedinApi.refreshCredentials({
      account: { platformData: null },
      refreshToken: "r2",
      now: NOW,
    });
    await linkedinApi.refreshCredentials({
      account: { platformData: { kind: "organization", app: "pages" } },
      refreshToken: "r3",
      now: NOW,
    });
    expect(
      callsTo(fetchMock, "POST", "/oauth/v2/accessToken").map(
        (call) => formOf(call).client_id,
      ),
    ).toEqual(["li_client", "li_client", "li_pages_client"]);
  });

  it("appli « profile » retirée : rafraîchissement refusé (configuration), sans appel", async () => {
    usePagesApp();
    delete process.env.LINKEDIN_CLIENT_ID;
    const fetchMock = stubFetch([]);
    await expect(
      linkedinApi.refreshCredentials({
        account: { platformData: { kind: "person", app: "profile" } },
        refreshToken: "r1",
        now: NOW,
      }),
    ).rejects.toThrow(/appli LinkedIn profile/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(linkedinApi.isConfigured()).toBe(true);
  });
});

describe("publication", () => {
  it("échappe le texte (little text format) en gardant les hashtags", () => {
    expect(escapeLittleText("Promo (-20 %) #soldes @Paul [lien] a_b *x*")).toBe(
      "Promo \\(-20 %\\) #soldes \\@Paul \\[lien\\] a\\_b \\*x\\*",
    );
    expect(escapeLittleText("# seul, C# et \\")).toBe("\\# seul, C\\# et \\\\");
  });

  it("image déposée (Bearer), attente AVAILABLE, post et adresse publique", async () => {
    process.env.LINKEDIN_API_VERSION = "202607";
    const fetchMock = stubFetch([
      on(
        "POST",
        "/rest/images",
        jsonResponse({
          value: {
            uploadUrl: "https://www.linkedin.com/dms-uploads/xyz",
            image: "urn:li:image:C4E",
          },
        }),
      ),
      on("PUT", "dms-uploads", jsonResponse(undefined, 201)),
      on(
        "GET",
        "/rest/images/",
        sequence(
          jsonResponse({ status: "PROCESSING" }),
          jsonResponse({ status: "AVAILABLE" }),
        ),
      ),
      on(
        "POST",
        "/rest/posts",
        jsonResponse(undefined, 201, { "x-restli-id": "urn:li:share:777" }),
      ),
    ]);
    const result = await linkedinApi.publish({
      account: organization,
      accessToken: "li_token",
      content: "Bonjour (test)",
      media: [image],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "urn:li:share:777",
      platformPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:777/",
    });
    const init = callsTo(fetchMock, "POST", "/rest/images")[0];
    expect(jsonOf(init)).toEqual({
      initializeUploadRequest: { owner: "urn:li:organization:42" },
    });
    expect(init[1].headers["Linkedin-Version"]).toBe("202607");
    const put = callsTo(fetchMock, "PUT", "dms-uploads")[0];
    expect(put[1].headers.Authorization).toBe("Bearer li_token");
    const post = jsonOf(callsTo(fetchMock, "POST", "/rest/posts")[0]);
    expect(post).toMatchObject({
      author: "urn:li:organization:42",
      commentary: "Bonjour \\(test\\)",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
      content: { media: { id: "urn:li:image:C4E" } },
    });
  });

  it("appli « Share on LinkedIn » : statut de l'image illisible (403), on publie quand même ; plusieurs images", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/rest/images",
        sequence(
          jsonResponse({
            value: { uploadUrl: "https://up/1", image: "urn:li:image:1" },
          }),
          jsonResponse({
            value: { uploadUrl: "https://up/2", image: "urn:li:image:2" },
          }),
        ),
      ),
      on("PUT", "https://up/", jsonResponse(undefined, 201)),
      on("GET", "/rest/images/", jsonResponse({ status: 403 }, 403)),
      on(
        "POST",
        "/rest/posts",
        jsonResponse(undefined, 201, { "x-restli-id": "urn:li:share:1" }),
      ),
    ]);
    await linkedinApi.publish({
      account: person,
      accessToken: "t",
      content: "",
      media: [image, image],
    });
    const post = jsonOf(callsTo(fetchMock, "POST", "/rest/posts")[0]);
    expect(post.content).toEqual({
      multiImage: {
        images: [{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }],
      },
    });
  });

  it("erreurs : jeton révoqué, limite de débit, contenu en double, version arrêtée", async () => {
    const publish = () =>
      linkedinApi.publish({
        account: person,
        accessToken: "t",
        content: "x",
        media: [],
      });

    stubFetch([
      on(
        "POST",
        "/rest/posts",
        jsonResponse(
          { status: 401, serviceErrorCode: 65601, message: "Revoked" },
          401,
        ),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({ authInvalid: true });

    stubFetch([
      on(
        "POST",
        "/rest/posts",
        jsonResponse({ status: 429, message: "Resource level throttle" }, 429),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      transient: true,
      category: "platform_rate_limit",
    });

    stubFetch([
      on(
        "POST",
        "/rest/posts",
        jsonResponse(
          { status: 422, message: "Content is a duplicate of urn:li:share:1" },
          422,
        ),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "user_content",
      detail: "Content is a duplicate of urn:li:share:1",
    });

    stubFetch([
      on(
        "POST",
        "/rest/posts",
        jsonResponse({ status: 426, code: "NONEXISTENT_VERSION" }, 426),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "platform_rejected",
      transient: false,
    });
  });
});
