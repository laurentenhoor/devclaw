# DevClaw Testing Guide

Comprehensive automated testing for DevClaw onboarding and setup.

## Quick Start

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run in watch mode (auto-rerun on changes)
npm run test:watch

# Run with UI (browser-based test explorer)
npm run test:ui
```

## Test Coverage

### Scenario 1: New User (No Prior DevClaw Setup)
**File:** `tests/setup/new-user.test.ts`

**What's tested:**
- First-time agent creation with default models
- Channel binding creation (telegram/whatsapp)
- Workspace file generation (AGENTS.md, HEARTBEAT.md, roles/, memory/)
- Plugin configuration initialization
- Error handling: channel not configured
- Error handling: channel disabled

**Example:**
```typescript
// Before: openclaw.json has no DevClaw agents
{
  "agents": { "list": [{ "id": "main", ... }] },
  "bindings": [],
  "plugins": { "entries": {} }
}

// After: New orchestrator created
{
  "agents": {
    "list": [
      { "id": "main", ... },
      { "id": "my-first-orchestrator", ... }
    ]
  },
  "bindings": [
    { "agentId": "my-first-orchestrator", "match": { "channel": "telegram" } }
  ],
  "plugins": {
    "entries": {
      "devclaw": {
        "config": {
          "models": {
            "junior": "anthropic/claude-haiku-4-5",
            "medior": "anthropic/claude-sonnet-4-5",
            "senior": "anthropic/claude-opus-4-5",
            "qa": "anthropic/claude-sonnet-4-5"
          }
        }
      }
    }
  }
}
```

### Scenario 2: Existing User (Migration)
**File:** `tests/setup/existing-user.test.ts`

**What's tested:**
- Channel conflict detection (existing channel-wide binding)
- Binding migration from old agent to new agent
- Custom model preservation during migration
- Old agent preservation (not deleted)
- Error handling: migration source doesn't exist
- Error handling: migration source has no binding

**Example:**
```typescript
// Before: Old orchestrator has telegram binding
{
  "agents": {
    "list": [
      { "id": "main", ... },
      { "id": "old-orchestrator", ... }
    ]
  },
  "bindings": [
    { "agentId": "old-orchestrator", "match": { "channel": "telegram" } }
  ]
}

// After: Binding migrated to new orchestrator
{
  "agents": {
    "list": [
      { "id": "main", ... },
      { "id": "old-orchestrator", ... },
      { "id": "new-orchestrator", ... }
    ]
  },
  "bindings": [
    { "agentId": "new-orchestrator", "match": { "channel": "telegram" } }
  ]
}
```

### Scenario 3: Power User (Multiple Agents)
**File:** `tests/setup/power-user.test.ts`

**What's tested:**
- No conflicts with group-specific bindings
- Channel-wide binding creation alongside group bindings
- Multiple orchestrators coexisting
- Routing logic (specific bindings win over channel-wide)
- WhatsApp support
- Scale testing (12+ orchestrators)

**Example:**
```typescript
// Before: Two project orchestrators with group-specific bindings
{
  "agents": {
    "list": [
      { "id": "project-a-orchestrator", ... },
      { "id": "project-b-orchestrator", ... }
    ]
  },
  "bindings": [
    {
      "agentId": "project-a-orchestrator",
      "match": { "channel": "telegram", "peer": { "kind": "group", "id": "-1001234567890" } }
    },
    {
      "agentId": "project-b-orchestrator",
      "match": { "channel": "telegram", "peer": { "kind": "group", "id": "-1009876543210" } }
    }
  ]
}

// After: Channel-wide orchestrator added (no conflicts)
{
  "agents": {
    "list": [
      { "id": "project-a-orchestrator", ... },
      { "id": "project-b-orchestrator", ... },
      { "id": "global-orchestrator", ... }
    ]
  },
  "bindings": [
    {
      "agentId": "project-a-orchestrator",
      "match": { "channel": "telegram", "peer": { "kind": "group", "id": "-1001234567890" } }
    },
    {
      "agentId": "project-b-orchestrator",
      "match": { "channel": "telegram", "peer": { "kind": "group", "id": "-1009876543210" } }
    },
    {
      "agentId": "global-orchestrator",
      "match": { "channel": "telegram" }  // Channel-wide (no peer)
    }
  ]
}

// Routing: Group messages go to specific agents, everything else goes to global
```

## Test Architecture

### Mock File System
The tests use an in-memory mock file system (`MockFileSystem`) that simulates:
- Reading/writing openclaw.json
- Creating/reading workspace files
- Tracking command executions (openclaw agents add)

**Why?** Tests run in isolation without touching the real file system, making them:
- Fast (no I/O)
- Reliable (no file conflicts)
- Repeatable (clean state every test)

### Fixtures
Pre-built configurations for different user types:
- `createNewUserConfig()` - Empty slate
- `createCommonUserConfig()` - One orchestrator with binding
- `createPowerUserConfig()` - Multiple orchestrators with group bindings
- `createNoChannelConfig()` - Channel not configured
- `createDisabledChannelConfig()` - Channel disabled

### Assertions
Reusable assertion helpers that make tests readable:
```typescript
assertAgentExists(mockFs, "my-agent", "My Agent");
assertChannelBinding(mockFs, "my-agent", "telegram");
assertWorkspaceFilesExist(mockFs, "my-agent");
assertDevClawConfig(mockFs, { junior: "anthropic/claude-haiku-4-5" });
```

## CI/CD Integration

### GitHub Actions
```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

### GitLab CI
```yaml
test:
  image: node:20
  script:
    - npm ci
    - npm test
    - npm run test:coverage
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

## Debugging Tests

### Run specific test
```bash
npm test -- new-user              # Run all new-user tests
npm test -- "should create agent" # Run tests matching pattern
```

### Debug with Node inspector
```bash
node --inspect-brk node_modules/.bin/vitest run
```

Then open Chrome DevTools at `chrome://inspect`

### View coverage report
```bash
npm run test:coverage
open coverage/index.html
```

## Adding Tests

### 1. Choose the right test file
- New feature → `tests/setup/new-user.test.ts`
- Migration feature → `tests/setup/existing-user.test.ts`
- Multi-agent feature → `tests/setup/power-user.test.ts`

### 2. Write the test
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MockFileSystem } from "../helpers/mock-fs.js";
import { createNewUserConfig } from "../helpers/fixtures.js";
import { assertAgentExists } from "../helpers/assertions.js";

describe("My new feature", () => {
  let mockFs: MockFileSystem;

  beforeEach(() => {
    mockFs = new MockFileSystem(createNewUserConfig());
  });

  it("should do something useful", async () => {
    // GIVEN: initial state (via fixture)
    const beforeCount = countAgents(mockFs);

    // WHEN: execute the operation
    const config = mockFs.getConfig();
    config.agents.list.push({
      id: "test-agent",
      name: "Test Agent",
      workspace: "/home/test/.openclaw/workspace-test-agent",
      agentDir: "/home/test/.openclaw/agents/test-agent/agent",
    });
    mockFs.setConfig(config);

    // THEN: verify the outcome
    assertAgentExists(mockFs, "test-agent", "Test Agent");
    expect(countAgents(mockFs)).toBe(beforeCount + 1);
  });
});
```

### 3. Run your test
```bash
npm test -- "should do something useful"
```

## Best Practices

### ✅ DO
- Test one thing per test
- Use descriptive test names ("should create agent with telegram binding")
- Use fixtures for initial state
- Use assertion helpers for readability
- Test error cases

### ❌ DON'T
- Test implementation details (test behavior, not internals)
- Share state between tests (use beforeEach)
- Mock everything (only mock file system and commands)
- Write brittle tests (avoid hard-coded UUIDs, timestamps)

## Test Metrics

Current coverage:
- **Lines:** Target 80%+
- **Functions:** Target 90%+
- **Branches:** Target 75%+

Run `npm run test:coverage` to see detailed metrics.
