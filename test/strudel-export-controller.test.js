const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scope = { projectId: "a".repeat(32), instanceId: "b".repeat(32), documentPath: "sound/index.html", runtimeGeneration: 1, sourceRevision: "c".repeat(64) };
const snapshot = () => ({ bpm: 120, cycles: 1, tailSeconds: 0.5, parameterDigest: "d".repeat(64), events: [] });
const request = (exportId = "export-one") => ({ exportId, expectedSourceRevision: scope.sourceRevision, snapshot: snapshot() });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(options = {}) {
  assert.ok(fs.existsSync(path.join(__dirname, "../src/strudel-export-controller.js")), "Strudel export controller is implemented");
  const { createStrudelExportController } = require("../src/strudel-export-controller");
  const { encodePCM16Wav } = require("../src/strudel-export-renderer");
  const { snapshotTiming } = require("../src/strudel-export-policy");
  const gate = deferred(), saveGate = deferred(), saved = [], attached = [], notifications = [];
  let valid = true, committed;
  const result = () => {
    const frames = snapshotTiming(snapshot()).frames;
    return { wavBytes: Buffer.from(encodePCM16Wav({ sampleRate: 48e3, numberOfChannels: 2, length: frames, getChannelData: () => new Float32Array(frames) })), duration: frames / 48e3, sampleRate: 48e3, channels: 2 };
  };
  const controller = createStrudelExportController({
    assertScope: () => {
      if (!valid) throw new Error("Runtime changed");
    },
    captureDependency: () => ({ source: "pinned A", digest: "e".repeat(64) }),
    render: async (_s, { signal, kitSource }) => {
      assert.equal(kitSource, "pinned A");
      if (options.renderFailure) throw new Error("render failed");
      if (options.onRender) options.onRender(signal);
      if (options.deferredRender) await gate.promise;
      return result();
    },
    findExport: async () => options.existing || committed || null,
    isAttached: async () => false,
    saveMedia: async (payload) => {
      saved.push(payload);
      if (options.deferredSave) await saveGate.promise;
      if (options.saveFailure) throw new Error("storage full");
      committed = { id: "f".repeat(32), scope: payload.scope, wavBytes: result().wavBytes };
      return "f".repeat(32);
    },
    attach: async (projectId, ids) => {
      attached.push({ projectId, ids });
      if (options.attachFailure) throw new Error("attachment failed");
    },
    onExport: (receipt) => {
      notifications.push(receipt);
      if (options.notifyFailure) throw new Error("notification failed");
    }
  });
  return { controller, gate, saveGate, saved, attached, notifications, invalidate: () => {
    valid = false;
    controller.invalidate("Runtime changed");
  }, result };
}
test("cancel_prevents_late_save", async () => {
  let signal;
  const f = fixture({ deferredRender: true, onRender: (s) => {
    signal = s;
  } });
  const p = f.controller.start(scope, request());
  await tick();
  f.controller.cancel(scope, "export-one");
  assert.equal(signal.aborted, true);
  f.gate.resolve();
  await assert.rejects(p, /cancel/i);
  assert.equal(f.saved.length, 0);
});
test("durable_save_survives_attach_failure", async () => {
  const f = fixture({ attachFailure: true, notifyFailure: true });
  const r = await f.controller.start(scope, request());
  assert.equal(r.assetId, "f".repeat(32));
  assert.equal(r.attachmentStatus, "saved-only");
  assert.match(r.warning, /Media/);
  assert.equal(f.saved.length, 1);
});
test("repeat_id_returns_same_receipt", async () => {
  const f = fixture({ deferredRender: true });
  const a = f.controller.start(scope, request()), b = f.controller.start(scope, request());
  await tick();
  f.gate.resolve();
  const [r1, r2] = await Promise.all([a, b]);
  assert.equal(r2.assetId, r1.assetId);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].scope.kind, "strudel-export");
  assert.equal(f.saved[0].scope.kitDigest, "e".repeat(64));
});
test("changed_content_rejects_same_id", async () => {
  const f = fixture();
  await f.controller.start(scope, request());
  const changed = request();
  changed.snapshot.bpm = 100;
  await assert.rejects(f.controller.start(scope, changed), /different content/i);
  assert.equal(f.saved.length, 1);
});
test("switch_never_attaches_wrong_project", async () => {
  const f = fixture({ deferredRender: true });
  const p = f.controller.start(scope, request());
  await tick();
  f.invalidate();
  f.gate.resolve();
  await assert.rejects(p, /changed|cancel/i);
  assert.equal(f.saved.length, 0);
  assert.equal(f.attached.length, 0);
});
test("cancel_during_admitted_save_returns_saved_receipt_without_attachment", async () => {
  const f = fixture({ deferredSave: true });
  const p = f.controller.start(scope, request());
  await tick();
  assert.equal(f.saved.length, 1);
  f.controller.cancel(scope, "export-one");
  f.saveGate.resolve();
  const r = await p;
  assert.equal(r.attachmentStatus, "saved-only");
  assert.equal(r.assetId, "f".repeat(32));
  assert.equal(f.attached.length, 0);
});
test("failed_storage_releases_reservation_and_busy_lock", async () => {
  const f = fixture({ saveFailure: true });
  await assert.rejects(f.controller.start(scope, request()), /storage full/);
  await assert.rejects(f.controller.start(scope, request()), /storage full/);
  assert.equal(f.saved.length, 2);
});
test("one_export_at_a_time_and_cancel_after_save_cannot_erase_success", async () => {
  const f = fixture({ deferredRender: true });
  const p = f.controller.start(scope, request());
  await tick();
  await assert.rejects(f.controller.start(scope, request("another")), /already|progress/i);
  f.gate.resolve();
  const r = await p;
  f.controller.cancel(scope, "export-one");
  assert.deepEqual(await f.controller.start(scope, request()), r);
  assert.equal(f.saved.length, 1);
});
module.exports = { scope, request, snapshot, fixture };
test("async_notification_failure_cannot_reject_a_committed_asset", async () => {
  const f = fixture();
  const { createStrudelExportController } = require("../src/strudel-export-controller");
  const controller = createStrudelExportController({
    assertScope: () => {
    },
    captureDependency: () => ({ source: "pinned A", digest: "e".repeat(64) }),
    render: async () => f.result(),
    findExport: async () => null,
    saveMedia: async () => "f".repeat(32),
    attach: async () => {
    },
    onExport: async () => {
      throw new Error("async notification failure");
    }
  });
  const receipt = await controller.start(scope, request());
  assert.equal(receipt.assetId, "f".repeat(32));
});
test("recovered_asset_survives_cancelled_lookup_and_failed_attachment_inspection", async () => {
  const f = fixture();
  const { createStrudelExportController } = require("../src/strudel-export-controller");
  const { validateStrudelSnapshot } = require("../src/strudel-export-policy");
  const crypto = require("node:crypto");
  const digest = crypto.createHash("sha256").update(JSON.stringify({ sourceRevision: scope.sourceRevision, kitDigest: "e".repeat(64), snapshot: validateStrudelSnapshot(snapshot()) })).digest("hex");
  const gate = deferred();
  let saves = 0;
  const controller = createStrudelExportController({
    assertScope: () => {
    },
    captureDependency: () => ({ source: "pinned A", digest: "e".repeat(64) }),
    findExport: async () => {
      await gate.promise;
      return { id: "f".repeat(32), wavBytes: f.result().wavBytes, scope: { contentDigest: digest, sourceRevision: scope.sourceRevision, kitDigest: "e".repeat(64) } };
    },
    isAttached: async () => {
      throw new Error("project no longer readable");
    },
    saveMedia: async () => {
      saves++;
    }
  });
  const p = controller.start(scope, request());
  await tick();
  controller.cancel(scope, "export-one");
  gate.resolve();
  const receipt = await p;
  assert.equal(receipt.assetId, "f".repeat(32));
  assert.equal(receipt.attachmentStatus, "saved-only");
  assert.match(receipt.warning, /Media/);
  assert.equal(saves, 0);
});

test('admission_freezes_request_identity_and_snapshot_against_late_mutation', async () => {
  const f = fixture({ deferredRender: true }); const mutableScope = { ...scope }, input = request();
  const p = f.controller.start(mutableScope, input); await tick(); input.exportId = 'late-id'; input.snapshot.bpm = 240; mutableScope.projectId = '9'.repeat(32); f.gate.resolve();
  const receipt = await p; assert.equal(receipt.exportId, 'export-one'); assert.equal(receipt.projectId, scope.projectId); assert.equal(f.saved[0].scope.bpm, 120); assert.equal(f.saved[0].scope.exportId, 'export-one');
});
test('source_changes_without_generation_change_reject_before_any_save', async () => {
  const f = fixture(); const { createStrudelExportController } = require('../src/strudel-export-controller');
  const gate = deferred(); let currentRevision = scope.sourceRevision, saves = 0;
  const controller = createStrudelExportController({ assertScope: s => { if (s.sourceRevision !== currentRevision) throw new Error('Source/kit revision changed'); }, captureDependency: () => ({ source: 'A', digest: 'e'.repeat(64) }),
    findExport: async () => null, render: async () => { await gate.promise; return f.result(); }, saveMedia: async () => { saves++; } });
  const p = controller.start(scope, request()); await tick(); currentRevision = '9'.repeat(64); gate.resolve(); await assert.rejects(p, /revision changed/); assert.equal(saves, 0);
});

test('attachment_error_after_commit_reports_actual_project_membership', async () => {
  const f = fixture(); const { createStrudelExportController } = require('../src/strudel-export-controller');
  const controller = createStrudelExportController({ assertScope: () => {}, captureDependency: () => ({ source: 'A', digest: 'e'.repeat(64) }), findExport: async () => null,
    render: async () => f.result(), saveMedia: async () => 'f'.repeat(32), attach: async () => { throw new Error('preview notification failed after attachment'); }, isAttached: async () => true });
  const receipt = await controller.start(scope, request()); assert.equal(receipt.assetId, 'f'.repeat(32)); assert.equal(receipt.attachmentStatus, 'attached'); assert.match(receipt.warning, /Media/);
});
