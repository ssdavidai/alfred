import { test } from "node:test";
import assert from "node:assert/strict";

import { applyOutboundCustomParameters } from "./outbound-metadata.js";

test("Twilio start customParameters set outbound Alfred persona", () => {
  const opts = applyOutboundCustomParameters(
    { tenantId: "main", initiator: "user" },
    { initiator: "alfred", intent: "Call Sir about calendars" },
  );

  assert.deepEqual(opts, {
    tenantId: "main",
    initiator: "alfred",
    intent: "Call Sir about calendars",
  });
});

test("non-Alfred customParameters preserve inbound user persona", () => {
  const opts = { tenantId: "main", initiator: "user" as const };
  assert.equal(applyOutboundCustomParameters(opts, { initiator: "user" }), opts);
});
