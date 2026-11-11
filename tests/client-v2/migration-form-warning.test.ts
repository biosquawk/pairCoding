import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeSettingsV2 } from '../../src/components/RuntimeSettingsV2';
import { validateExecutionView, validateSettingsV2 } from '../../src/shared/validation-v2';
import type { ExecutionView } from '../../src/shared/runtime-v2';
import { execution, settings } from './fixtures';

const migrationCode = 'LEGACY_RUN_PROFILE_REQUIRES_MIGRATION';
function migrationExecution(): ExecutionView {
  const view = execution();
  const problem = { code: migrationCode, message: 'Wymagana migracja.', recovery: 'Zapisz jawnie V2.', retryable: false };
  view.runtime.state = 'CONFIG_ERROR'; view.runtime.problem = problem;
  view.modes = { RUN_MAIN: { canRun: false, problem }, RUN_TESTS: { canRun: false, problem } };
  return view;
}
function render(view: ExecutionView | null, rawSettings: unknown = { ...settings(), runProfiles: [] }, migrationDraft = undefined as ReturnType<typeof settings> | undefined) {
  let saves = 0;
  const before = JSON.stringify(rawSettings);
  const html = renderToStaticMarkup(React.createElement(RuntimeSettingsV2, {
    open: true, settings: rawSettings, execution: view, expectedWorkspaceVersion: 1,
    connected: true, canSave: true, migrationDraft,
    onClose() {}, onSave: async () => { saves++; return { ok: false as const, message: 'Niepotwierdzony zapis.' }; },
  }));
  assert.equal(saves, 0, 'rendering must not call SAVE');
  assert.equal(JSON.stringify(rawSettings), before, 'rendering must preserve its input');
  return html;
}

test('valid-shaped in-memory migration form keeps explicit migration/raw-preserved warning beside editable form', () => {
  const form = { ...settings(), runProfiles: [] };
  const view = migrationExecution();
  assert.equal(validateSettingsV2(form), true); assert.equal(validateExecutionView(view), true);
  const html = render(view, form);
  assert.match(html, /role="alert"[^>]*>[\s\S]*LEGACY_RUN_PROFILE_REQUIRES_MIGRATION/);
  assert.match(html, /Oryginalne ustawienia \(raw\) pozostają bez zmian/);
  assert.match(html, /Otwarcie i edycja formularza nie wykonują migracji/);
  assert.match(html, /dopiero po jawnym, potwierdzonym zapisie/);
  assert.match(html, /<form/); assert.match(html, /type="submit"[^>]*>Zapisz ustawienia/);
  assert.match(html, /Włącz program/); assert.match(html, /Włącz testy/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.equal(view.modes.RUN_MAIN.canRun, false); assert.equal(view.modes.RUN_TESTS.canRun, false);
});

test('unrelated CONFIG_ERROR and DAEMON_OFF are not labelled as migration', () => {
  for (const state of ['CONFIG_ERROR', 'DAEMON_OFF'] as const) {
    const view = migrationExecution(); view.runtime.state = state;
    view.runtime.problem!.code = state === 'CONFIG_ERROR' ? 'TASK_CONFIG_INVALID' : 'DAEMON_OFF';
    assert.equal(validateExecutionView(view), true);
    assert.doesNotMatch(render(view), /LEGACY_RUN_PROFILE_REQUIRES_MIGRATION|Oryginalne ustawienia \(raw\)/);
  }
});

test('migration requires CONFIG_ERROR, exact problem code and validated ExecutionView', () => {
  const notConfigError = migrationExecution(); notConfigError.runtime.state = 'DAEMON_OFF';
  const differentCode = migrationExecution(); differentCode.runtime.problem!.code += '_OTHER';
  const invalid = migrationExecution(); invalid.runtime.taskFields = 'invalid' as any;
  assert.equal(validateExecutionView(invalid), false);
  for (const view of [notConfigError, differentCode, invalid, execution(), null]) {
    assert.doesNotMatch(render(view), /Oryginalne ustawienia \(raw\) pozostają bez zmian/);
  }
});

test('legacy unknown shape retains existing explicit migrationDraft path', () => {
  const legacy = { runProfiles: [{ executable: 'do-not-interpret' }], unrelated: 'preserved' };
  const html = render(migrationExecution(), legacy, settings());
  assert.match(html, /LEGACY_RUN_PROFILE_REQUIRES_MIGRATION/);
  assert.match(html, /Przygotuj migrację V2/); assert.doesNotMatch(html, /<form/);
  assert.equal(legacy.runProfiles[0].executable, 'do-not-interpret');
});
