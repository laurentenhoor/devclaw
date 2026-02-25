/**
 * Tests for notify label helpers.
 *
 * Covers:
 * - getNotifyLabel / NOTIFY_LABEL_PREFIX / NOTIFY_LABEL_COLOR
 * - resolveNotifyChannel (new format + legacy backward compat)
 *
 * Run with: npx tsx --test lib/tools/worker/group-isolation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getNotifyLabel,
  NOTIFY_LABEL_PREFIX,
  NOTIFY_LABEL_COLOR,
  resolveNotifyChannel,
} from "../../workflow/index.js";

// ---------------------------------------------------------------------------
// getNotifyLabel / constants
// ---------------------------------------------------------------------------

describe("notify label helpers", () => {
  it("should build notify label from channel type and name", () => {
    assert.strictEqual(getNotifyLabel("telegram", "primary"), "notify:telegram:primary");
    assert.strictEqual(getNotifyLabel("whatsapp", "dev-chat"), "notify:whatsapp:dev-chat");
  });

  it("should build notify label with index fallback", () => {
    assert.strictEqual(getNotifyLabel("telegram", "0"), "notify:telegram:0");
  });

  it("NOTIFY_LABEL_PREFIX should be 'notify:'", () => {
    assert.strictEqual(NOTIFY_LABEL_PREFIX, "notify:");
  });

  it("NOTIFY_LABEL_COLOR should be light grey", () => {
    assert.strictEqual(NOTIFY_LABEL_COLOR, "#e4e4e4");
  });

  it("getNotifyLabel output should start with NOTIFY_LABEL_PREFIX", () => {
    const label = getNotifyLabel("telegram", "primary");
    assert.ok(label.startsWith(NOTIFY_LABEL_PREFIX));
  });
});

// ---------------------------------------------------------------------------
// resolveNotifyChannel — new format (notify:{channel}:{name})
// ---------------------------------------------------------------------------

describe("resolveNotifyChannel (new format)", () => {
  const channels = [
    { channelId: "-111", channel: "telegram", name: "primary" },
    { channelId: "-222", channel: "whatsapp", name: "dev-chat" },
  ];

  it("should resolve channel by channel type and name", () => {
    const result = resolveNotifyChannel(["To Do", "notify:whatsapp:dev-chat"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-222");
    assert.strictEqual(result!.channel, "whatsapp");
  });

  it("should resolve channel by channel type and index", () => {
    const result = resolveNotifyChannel(["To Do", "notify:whatsapp:1"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-222");
    assert.strictEqual(result!.channel, "whatsapp");
  });

  it("should fall back to first channel when new-format label matches nothing", () => {
    const result = resolveNotifyChannel(["To Do", "notify:discord:unknown"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-111");
  });

  it("should fall back to first channel when no notify label present", () => {
    const result = resolveNotifyChannel(["To Do", "bug"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-111");
  });

  it("should return undefined when channels is empty", () => {
    const result = resolveNotifyChannel(["To Do", "notify:telegram:primary"], []);
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveNotifyChannel — legacy format (notify:{channelId})
// ---------------------------------------------------------------------------

describe("resolveNotifyChannel (legacy format)", () => {
  const channels = [
    { channelId: "-111", channel: "telegram", name: "primary" },
    { channelId: "-222", channel: "whatsapp", name: "dev-chat" },
  ];

  it("should resolve channel matching legacy notify label", () => {
    const result = resolveNotifyChannel(["To Do", "notify:-222"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-222");
    assert.strictEqual(result!.channel, "whatsapp");
  });

  it("should fall back to first channel when legacy label matches unknown channelId", () => {
    const result = resolveNotifyChannel(["To Do", "notify:-999"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-111");
  });

  it("should return first channel when no notify label and multiple channels", () => {
    const result = resolveNotifyChannel(["To Do"], channels);
    assert.ok(result);
    assert.strictEqual(result!.channelId, "-111");
  });
});
