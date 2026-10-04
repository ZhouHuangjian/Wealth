import test from "node:test";
import assert from "node:assert/strict";
import {
  adminAccessRequest,
  canDelegate,
  canManageAdminAccess,
  isDelegationDenied,
} from "../src/admin-access.ts";
import { api, ApiError, subscribeApiFailures } from "../src/api.ts";

test("administrator delegation fails closed even when workspace metadata is readable", () => {
  for (const space of [
    null,
    {},
    { admin_access_enabled: true },
    { can_delegate: false },
    { can_delegate: "true" },
    { can_delegate: 1 },
  ])
    assert.equal(canDelegate(space), false);
  assert.equal(canDelegate({ can_delegate: true }), true);
});
test("only an ordinary owner with fresh server permission can set consent, including explicit revocation", () => {
  const access = { enabled: false, version: 0, can_manage: true };
  assert.deepEqual(adminAccessRequest(access, { role: "owner" }, true), {
    enabled: true,
    version: 0,
  });
  assert.deepEqual(
    adminAccessRequest(
      { ...access, enabled: true, version: 3 },
      { role: "owner" },
      false,
    ),
    { enabled: false, version: 3 },
  );
  for (const space of [
    { role: "owner", administration: true },
    { role: "editor" },
    { role: "viewer" },
  ]) {
    assert.equal(canManageAdminAccess(access, space), false);
    assert.throws(
      () => adminAccessRequest(access, space, true),
      /仅空间所有者/,
    );
  }
  assert.throws(
    () =>
      adminAccessRequest(
        { ...access, can_manage: false },
        { role: "owner" },
        true,
      ),
    /仅空间所有者/,
  );
  assert.throws(
    () =>
      adminAccessRequest(
        { ...access, version: undefined },
        { role: "owner" },
        true,
      ),
    /重新读取/,
  );
  assert.throws(
    () => adminAccessRequest(access, { role: "owner" }, "true"),
    /重新读取/,
  );
});
test("403 eviction is scoped to this exact workspace rather than another book or platform operations", () => {
  for (const path of [
    "/spaces/book/events",
    "/spaces/book/overview?as_of=2026-10-05",
    "/admin/spaces/book",
  ])
    assert.equal(isDelegationDenied(path, 403, "book"), true);
  for (const path of [
    "/spaces/book-other/events",
    "/admin/users",
    "/spaces/other/home",
  ])
    assert.equal(isDelegationDenied(path, 403, "book"), false);
  assert.equal(isDelegationDenied("/spaces/book/events", 422, "book"), false);
});
test("API failure observer immediately receives denial metadata without financial content and can unsubscribe", async () => {
  const events = [];
  const stop = subscribeApiFailures((failure) => events.push(failure));
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: "admin_access_required",
        message: "所有者已撤销授权",
        fields: { private_balance: "12345" },
        financial_data: "private",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  await assert.rejects(
    api("/spaces/book/overview"),
    (error) => error instanceof ApiError && error.status === 403,
  );
  assert.deepEqual(events, [
    {
      path: "/spaces/book/overview",
      status: 403,
      code: "admin_access_required",
      message: "所有者已撤销授权",
    },
  ]);
  stop();
  await assert.rejects(api("/spaces/book/accounts"));
  assert.equal(events.length, 1);
});
test("a failing observer never replaces the actionable original API error", async () => {
  const stop = subscribeApiFailures(() => {
    throw new Error("observer failed");
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "无权访问" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    api("/spaces/book/overview"),
    (error) => error instanceof ApiError && error.message === "无权访问",
  );
  stop();
});
