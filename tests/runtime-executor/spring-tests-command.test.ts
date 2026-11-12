import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateRuntimeCommand, type RuntimeTaskSpec } from '../../src/server/execution/RuntimeCommand';
import type { ExecutionPlan } from '../../src/server/execution/ports';
import { canonicalJson } from '../../src/server/execution/files';

// Exact originalMutation.runStage.plan from preserved redacted P3 terminal-readback.json.
// Source SHA256: c48e9d25b0871907c80a2c82c0b669daa62d842e81af6b6eaf8b27c19e592481
// Original mutation SHA256: ee1588608943e16bdf788063384f0a8a3461a0d537b6e656c435716952e6a12b
// Paths/UUIDs below are inert historical data: no executor, adapter builder, FS or Docker call.
const storedPlan = {
  "artifacts": [
    "JUNIT_XML",
    "COMPILER_DIAGNOSTICS"
  ],
  "caches": [
    {
      "dependencyHash": "f17dc767719d79a019d105a5f08f2af4ef48b8aa295388972a86f8761cf722bd",
      "directory": "/home/darulec/dev/codex_prjects/projects/software_dev_2/Desks/SharedDesk/deliveries/_drafts/P4/paircoach-lightweight-remaining-profiles-package-readiness/host-spring21-execute/jobs/java-maven-21/cache/java-maven/2e7d2e1b605d5ab4e7637b86067ff38045961ca2c33b3086cc5b40240b5a3b3e/f17dc767719d79a019d105a5f08f2af4ef48b8aa295388972a86f8761cf722bd",
      "family": "java-maven",
      "readOnly": true,
      "toolchainHash": "2e7d2e1b605d5ab4e7637b86067ff38045961ca2c33b3086cc5b40240b5a3b3e"
    }
  ],
  "command": {
    "args": [
      "/opt/paircoach/runtime-task.mjs",
      "eyJjYWNoZSI6Ii9jYWNoZS8wIiwiZmFtaWx5IjoiamF2YS1tYXZlbiIsIm1hbmlmZXN0U2hhMjU2IjoiMGU5YmFhOWUyNzFkMDUyYzk2MzE3Y2ZlZGFkNzEyMGEzZGE0NzY1NjI2MGQ2Y2FlMmZiNzdjMDQ0ZDhlMzgxYyIsIm1vZGUiOiJSVU5fVEVTVFMiLCJwcmV2aWV3IjpmYWxzZSwicmVsZWFzZSI6MjEsInJ1bklkIjoiMGI2ZTgzOGYtOTFhZC00ZjVjLWJhYTctODg4NzA1OGVjYTBkIiwic2NoZW1hVmVyc2lvbiI6MSwidGFzayI6eyJlbnRyeSI6eyJjb250YWluZXJQb3J0Ijo4MDgwLCJoZWFsdGhQYXRoIjoiL3N1bSIsImtpbmQiOiJTUFJJTkdfQk9PVCJ9LCJ0ZXN0cyI6eyJuYW1lcyI6WyJkZW1vLkNvdW50ZXJBcHBsaWNhdGlvblRlc3QiXSwicGF0aHMiOltdfSwid29ya2luZ0RpcmVjdG9yeSI6Ii4ifX0"
    ],
    "environment": {
      "CI": "true",
      "LANG": "C.UTF-8",
      "LC_ALL": "C.UTF-8",
      "PYTHONDONTWRITEBYTECODE": "1",
      "TZ": "UTC"
    },
    "executable": "/opt/paircoach/node/bin/node",
    "workingDirectory": "/workspace"
  },
  "input": {
    "artifactsDirectory": "/home/darulec/dev/codex_prjects/projects/software_dev_2/Desks/SharedDesk/deliveries/_drafts/P4/paircoach-lightweight-remaining-profiles-package-readiness/host-spring21-execute/.paircoach-runtime/projects/088712ef39707e3ae646558665e92c3d92829ac6f072fcfee497902878a4659f/runs/0b6e838f-91ad-4f5c-baa7-8887058eca0d/artifacts",
    "buildDirectory": "/home/darulec/dev/codex_prjects/projects/software_dev_2/Desks/SharedDesk/deliveries/_drafts/P4/paircoach-lightweight-remaining-profiles-package-readiness/host-spring21-execute/.paircoach-runtime/projects/088712ef39707e3ae646558665e92c3d92829ac6f072fcfee497902878a4659f/runs/0b6e838f-91ad-4f5c-baa7-8887058eca0d/build",
    "files": [
      {
        "bytes": 1291,
        "documentVersion": 1,
        "path": "pom.xml",
        "sha256": "9de50edb2ed96da979731190442ae01e38b238d5600bbf7968baa928b2ce04e9"
      },
      {
        "bytes": 604,
        "documentVersion": 2,
        "path": "src/main/java/demo/CounterApplication.java",
        "sha256": "74c05672b178ac84d63ae9cc0c2d78e7330050733d71415148602c4e28c0b388"
      },
      {
        "bytes": 227,
        "documentVersion": 1,
        "path": "src/test/java/demo/CounterApplicationTest.java",
        "sha256": "793cf2a1303cf190d20d007e557120b35581948c020b1dae1bbdd462fbf384d8"
      },
      {
        "bytes": 781,
        "documentVersion": 1,
        "path": "task.v2.json",
        "sha256": "10b2443e47f4be18792f24d81e4cefc0e96cd6bfd6df9dccd7580cb5aa2f6634"
      }
    ],
    "identity": {
      "configurationGeneration": "a07506e7-6b80-457f-886c-20e67024711d",
      "manifestSha256": "0e9baa9e271d052c96317cfedad7120a3da47656260d6cae2fb77c044d8e381c",
      "profileId": "java-maven-21",
      "runId": "0b6e838f-91ad-4f5c-baa7-8887058eca0d",
      "workspaceVersion": 1
    },
    "immutableDirectory": "/home/darulec/dev/codex_prjects/projects/software_dev_2/Desks/SharedDesk/deliveries/_drafts/P4/paircoach-lightweight-remaining-profiles-package-readiness/host-spring21-execute/.paircoach-runtime/projects/088712ef39707e3ae646558665e92c3d92829ac6f072fcfee497902878a4659f/runs/0b6e838f-91ad-4f5c-baa7-8887058eca0d/input",
    "projectId": "5d13cfc0-a58f-417a-8105-de2d0aedb524",
    "sessionId": "70225fc2-1761-4a7f-bf8b-7c4cc91ff21e"
  },
  "isolation": {
    "capDropAll": true,
    "network": "none",
    "noNewPrivileges": true,
    "nonRootUser": "10001:10001",
    "readOnlyRoot": true
  },
  "lockedImage": {
    "digest": "sha256:e1a693f9b520344c3d8dba0637bf062570cf9483d096d3fc1f3b8036fa47e386",
    "image": "paircoach/runtime-java-maven-21:stage09",
    "imageId": "sha256:e1a693f9b520344c3d8dba0637bf062570cf9483d096d3fc1f3b8036fa47e386",
    "key": "java-maven-21",
    "tools": [
      {
        "name": "node",
        "version": "22.22.0"
      },
      {
        "name": "java",
        "version": "21.0.13"
      },
      {
        "name": "javac",
        "version": "21.0.13"
      },
      {
        "name": "maven",
        "version": "3.9.12"
      }
    ]
  },
  "mode": "RUN_TESTS",
  "ownership": {
    "containerName": "paircoach-c1fb2a52-0510-4778-8b10-2f29b584c902-java-maven-21-0b6e838f-91ad-4f5c-baa7-8887058eca0d",
    "engineId": "a2c520c9-d3f1-425a-852d-0621cd8b7ce3",
    "imageId": "sha256:e1a693f9b520344c3d8dba0637bf062570cf9483d096d3fc1f3b8036fa47e386",
    "installationId": "c1fb2a52-0510-4778-8b10-2f29b584c902",
    "profileId": "java-maven-21",
    "runId": "0b6e838f-91ad-4f5c-baa7-8887058eca0d"
  },
  "profile": {
    "adapterFamily": "java-maven",
    "analysis": {
      "languageLevel": "21",
      "preview": false
    },
    "compilerRelease": 21,
    "expectedTools": [
      {
        "name": "node",
        "version": "22.22.0"
      },
      {
        "name": "java",
        "version": "21.0.13"
      },
      {
        "name": "javac",
        "version": "21.0.13"
      },
      {
        "name": "maven",
        "version": "3.9.12"
      }
    ],
    "id": "java-maven-21",
    "imageLockKey": "java-maven-21",
    "label": "java-maven-21",
    "language": {
      "imageLockKey": null,
      "provider": "builtin",
      "serverJvm": null
    },
    "taskFields": [
      {
        "choices": [],
        "help": "Total compile/test/program and service startup budget; Stop remains available.",
        "input": "INTEGER",
        "key": "timeoutMs",
        "label": "Run timeout (ms)",
        "max": 3600000,
        "min": 1000,
        "required": true
      },
      {
        "choices": [],
        "help": "Relative to immutable project input.",
        "input": "PATH",
        "key": "workingDirectory",
        "label": "Task directory",
        "max": null,
        "min": null,
        "required": true
      },
      {
        "choices": [
          {
            "label": "JAVA_MAIN",
            "value": "JAVA_MAIN"
          },
          {
            "label": "SPRING_BOOT",
            "value": "SPRING_BOOT"
          },
          {
            "label": "TESTS",
            "value": "TESTS"
          }
        ],
        "help": "Select task mode.",
        "input": "CHOICE",
        "key": "entry.kind",
        "label": "Entry",
        "max": null,
        "min": null,
        "required": true
      },
      {
        "choices": [],
        "help": "Required for JAVA_MAIN: fully qualified Java class.",
        "input": "TEXT",
        "key": "entry.className",
        "label": "Main class",
        "max": null,
        "min": null,
        "required": true
      },
      {
        "choices": [],
        "help": "Required for SPRING_BOOT: container-local port.",
        "input": "INTEGER",
        "key": "entry.containerPort",
        "label": "Service port",
        "max": 65535,
        "min": 1,
        "required": true
      },
      {
        "choices": [],
        "help": "Required for SPRING_BOOT: container-local HTTP readiness path.",
        "input": "TEXT",
        "key": "entry.healthPath",
        "label": "Health path",
        "max": null,
        "min": null,
        "required": true
      },
      {
        "choices": [],
        "help": "Must be empty for Maven.",
        "input": "PATH",
        "key": "tests.paths",
        "label": "Test sources",
        "max": null,
        "min": null,
        "required": false
      },
      {
        "choices": [],
        "help": "Optional exact Maven class or class#method names; empty selects all tests.",
        "input": "TEXT",
        "key": "tests.names",
        "label": "Test names",
        "max": null,
        "min": null,
        "required": false
      }
    ]
  },
  "resources": {
    "cpus": 2,
    "logBytes": 10485760,
    "logFiles": 1,
    "memoryBytes": 2147483648,
    "pids": 256
  },
  "service": null,
  "timeoutMs": 120000
} satisfies ExecutionPlan;

function original(): ExecutionPlan { return structuredClone(storedPlan); }
function specOf(plan: ExecutionPlan): RuntimeTaskSpec {
  return JSON.parse(Buffer.from(plan.command.args[1], 'base64url').toString('utf8'));
}
function encode(plan: ExecutionPlan, spec: RuntimeTaskSpec): void {
  plan.command.args = [plan.command.args[0], Buffer.from(canonicalJson(spec)).toString('base64url')];
}
const service = () => ({ containerPort: 8080, healthPath: '/sum', bindHost: '127.0.0.1' as const, readinessTimeoutMs: 30000 });
function main(): ExecutionPlan {
  const plan = original(), spec = specOf(plan);
  plan.mode = spec.mode = 'RUN_MAIN'; plan.service = service(); encode(plan, spec);
  return plan;
}

test('UNIT exact retained Spring RUN_TESTS plan validates without a service', () => {
  const plan = original(), before = structuredClone(plan);
  assert.equal(createHash('sha256').update(canonicalJson(plan)).digest('hex'), 'd7acafb87a98b6672060510169c1e45208b96bcc619bb11dcc95826acb0e3af6');
  const spec = validateRuntimeCommand(plan);
  assert.equal(spec.runId, '0b6e838f-91ad-4f5c-baa7-8887058eca0d');
  assert.equal(spec.mode, 'RUN_TESTS');
  assert.deepEqual(spec.task.entry, { containerPort: 8080, healthPath: '/sum', kind: 'SPRING_BOOT' });
  assert.equal(plan.service, null); assert.equal(plan.isolation.network, 'none');
  assert.deepEqual(plan, before, 'validation must not rewrite original retained input');
});

test('UNIT same service-capable entry binds RUN_MAIN service port and health path', () => {
  assert.equal(validateRuntimeCommand(main()).mode, 'RUN_MAIN');
});

test('UNIT nonservice Main and Tests retain null-service behavior', () => {
  const program = main(), programSpec = specOf(program);
  programSpec.task.entry = { kind: 'JAVA_MAIN', className: 'demo.Main' };
  program.service = null; encode(program, programSpec);
  assert.equal(validateRuntimeCommand(program).mode, 'RUN_MAIN');
  const tests = original(), testSpec = specOf(tests);
  testSpec.task.entry = { kind: 'TESTS' }; encode(tests, testSpec);
  assert.equal(validateRuntimeCommand(tests).mode, 'RUN_TESTS');
});

type Mutation = (plan: ExecutionPlan, spec: RuntimeTaskSpec) => void;
const attacks: Record<string, { base?: () => ExecutionPlan; mutate: Mutation }> = {
  'TESTS cannot acquire service': { mutate: p => { p.service = service(); } },
  'MAIN missing service': { base: main, mutate: p => { p.service = null; } },
  'MAIN wrong port': { base: main, mutate: p => { p.service!.containerPort = 8081; } },
  'MAIN wrong health path': { base: main, mutate: p => { p.service!.healthPath = '/other'; } },
  'nonservice MAIN cannot acquire service': { base: main, mutate: (_p, s) => { s.task.entry = { kind: 'JAVA_MAIN', className: 'demo.Main' }; } },
  'nonservice TESTS cannot acquire service': { mutate: (p, s) => { s.task.entry = { kind: 'TESTS' }; p.service = service(); } },
  'run identity mismatch': { mutate: (_p, s) => { s.runId = 'other-run'; } },
  'manifest identity mismatch': { mutate: (_p, s) => { s.manifestSha256 = '0'.repeat(64); } },
  'mode identity mismatch': { mutate: (_p, s) => { s.mode = 'RUN_MAIN'; } },
  'family identity mismatch': { mutate: (_p, s) => { s.family = 'python'; } },
  'JDK identity mismatch': { mutate: (_p, s) => { s.release = 27; } },
  'preview identity mismatch': { mutate: (_p, s) => { s.preview = true; } },
  'task incompatible with profile': { mutate: (_p, s) => { s.task.entry = { kind: 'SCRIPT', path: 'main.py' }; } },
  'selector arbitrary flag': { mutate: (_p, s) => { s.task.tests.names = ['--inspect']; } },
  'selector shell injection': { mutate: (_p, s) => { s.task.tests.names = ['name;touch injected']; } },
  'selector path traversal': { mutate: (_p, s) => { s.task.tests.paths = ['../private']; } },
  'task cwd traversal': { mutate: (_p, s) => { s.task.workingDirectory = '../private'; } },
  'extra argv': { mutate: p => { p.command.args = [...p.command.args, '--eval']; } },
  'wrong dispatcher': { mutate: p => { p.command.args = ['/workspace/evil.mjs', p.command.args[1]]; } },
  'wrong executable': { mutate: p => { p.command.executable = '/usr/bin/node'; } },
  'extra environment': { mutate: p => { p.command.environment = { ...p.command.environment, NODE_OPTIONS: '--inspect' }; } },
  'RW prepared cache': { mutate: p => { p.caches = [{ ...p.caches[0], readOnly: false }]; } },
};
for (const [name, { base = original, mutate }] of Object.entries(attacks)) {
  test(`UNIT retained-plan guards reject ${name}`, () => {
    const plan = base(), spec = specOf(plan);
    // Encode only the spec mutation, then retain explicit argv mutations as supplied.
    const oldArgs = plan.command.args;
    mutate(plan, spec);
    if (plan.command.args === oldArgs) encode(plan, spec);
    assert.throws(() => validateRuntimeCommand(plan), /TASK_CONFIG_INVALID/);
  });
}
