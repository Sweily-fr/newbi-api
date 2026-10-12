import { describe, it, expect } from "vitest";
import {
  filterOrganizationMembers,
  organizationMemberIdentity,
  teamVisibilityFromGrid,
} from "../../src/utils/memberVisibility.js";

const member = (id, role, extra = {}) => ({
  id,
  name: id,
  email: `${id}@test.fr`,
  image: null,
  role,
  ...extra,
});

describe("memberVisibility", () => {
  it("identité : liste blanche, rôle du seul super admin", () => {
    expect(
      organizationMemberIdentity(
        member("u-1", "admin", { userId: "u-1", createdAt: new Date() }),
      ),
    ).toEqual({
      id: "u-1",
      userId: "u-1",
      name: "u-1",
      email: "u-1@test.fr",
      image: null,
      role: null,
    });
    expect(organizationMemberIdentity(member("u-2", "Owner,admin")).role).toBe(
      "owner",
    );
  });

  it("garde l'entrée de l'appelant, par id ou userId", () => {
    const list = [member("moi", "role_x"), member("u-1", "admin")];
    const filtered = filterOrganizationMembers(list, {
      callerUserId: "moi",
      canViewTeam: false,
    });
    expect(filtered[0]).toBe(list[0]);
    expect(filtered[1].role).toBeNull();
    expect(
      filterOrganizationMembers(list, {
        callerUserId: "moi",
        canViewTeam: true,
      }),
    ).toBe(list);
  });

  it("droits lus dans la grille ; sans grille, rien", () => {
    expect(teamVisibilityFromGrid({ team: ["view"] })).toEqual({
      canViewTeam: true,
      canViewInvitations: true,
    });
    expect(teamVisibilityFromGrid({ team: [] })).toEqual({
      canViewTeam: false,
      canViewInvitations: false,
    });
    expect(teamVisibilityFromGrid(null).canViewTeam).toBe(false);
  });
});
