/** Type the real Monaco URI-only module used in Node, avoiding loading editor CSS/DOM runtime. */
declare module 'monaco-editor/esm/vs/base/common/uri.js' {
  export { Uri as URI } from 'monaco-editor';
}
