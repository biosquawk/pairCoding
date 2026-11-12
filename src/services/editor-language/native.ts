import type * as M from 'monaco-editor';
/**
 * Stock Monaco has no public synchronous pre-edit acceptance hook. CompletionItem.command runs AFTER editing.
 * Public show* filters also omit Tool(27) in Monaco0.55, so filters alone are NOT the security boundary.
 * Disable each shipped native provider via public mode configuration, retaining all other mode settings.
 * App-owned providers use the facade, NEVER registerCompletionItemProvider/inline providers. An external plugin
 * registering new native providers would violate this integration boundary and must not be loaded.
 */
export function disableNativeCompletionProviders(monaco: typeof M): void {
  const l=monaco;
  const defaults=[l.typescript.typescriptDefaults,l.typescript.javascriptDefaults,l.json.jsonDefaults,
    l.css.cssDefaults,l.css.lessDefaults,l.css.scssDefaults,l.html.htmlDefaults,l.html.handlebarDefaults,l.html.razorDefaults];
  for (const mode of defaults) {
    if (mode.modeConfiguration.completionItems !== false)
      mode.setModeConfiguration({...mode.modeConfiguration,completionItems:false});
  }
}
