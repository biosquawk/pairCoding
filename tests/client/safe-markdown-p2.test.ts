import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../../src/components/SafeMarkdown';

const render = (content: string) => renderToStaticMarkup(React.createElement(SafeMarkdown, { content }));

test('literal angle brackets and ampersands are escaped exactly once by React', () => {
  const html = render('if (a < b && b > 0) & already &lt;typed&gt;');
  assert.match(html, />if \(a &lt; b &amp;&amp; b &gt; 0\) &amp; already &amp;lt;typed&amp;gt;<\/p>/);
  assert.doesNotMatch(html, /a &amp;lt; b/);
});

test('HTML/script/attribute-looking input stays literal text, never active markup', () => {
  const html = render('<script>alert("x")</script> <img src=x onerror=alert(1)> <iframe src="https://example.com">');
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;iframe src=&quot;https:\/\/example.com&quot;&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b/i);
});

test('inline code is literal single-escaped text and does not parse nested markdown', () => {
  const html = render('Use `<T> & **literal** <script>` safely.');
  assert.match(html, /<code\b[^>]*>&lt;T&gt; &amp; \*\*literal\*\* &lt;script&gt;<\/code>/);
  assert.doesNotMatch(html, /<strong|<script|&amp;lt;/);
});

test('closed and unclosed fences preserve literal code, newlines and language text', () => {
  for (const ending of ['\n```', '']) {
    const html = render('```<lang>\nconst x = a < b && b > 0;\n<script> **literal**' + ending);
    assert.match(html, />&lt;lang&gt;<\/div>/);
    assert.match(html, /<pre\b[^>]*>const x = a &lt; b &amp;&amp; b &gt; 0;\n&lt;script&gt; \*\*literal\*\*<\/pre>/);
    assert.doesNotMatch(html, /<script|<strong|&amp;lt;/);
  }
});

test('bold and italics preserve literal brackets without creating HTML', () => {
  const html = render('**<b> & bold** and *<i> & italic*');
  assert.match(html, /<strong\b[^>]*>&lt;b&gt; &amp; bold<\/strong>/);
  assert.match(html, /<em\b[^>]*>&lt;i&gt; &amp; italic<\/em>/);
  assert.doesNotMatch(html, /<b>|<i>|&amp;lt;/);
});

test('http/https links retain URL policy and literal single-escaped labels/attributes', () => {
  const html = render('[<label> & more](https://example.com/?x=1&y=<tag>) [plain](http://example.com)');
  assert.match(html, /href="https:\/\/example.com\/\?x=1&amp;y=&lt;tag&gt;"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, />&lt;label&gt; &amp; more<span\b/);
  assert.match(html, /href="http:\/\/example.com"/);
  assert.doesNotMatch(html, /<label>|&amp;lt;/);
});

test('unsafe/relative link schemes and image syntax cannot create active URLs or images', () => {
  for (const url of ['javascript:alert', 'data:text/html,<script>', 'vbscript:evil', 'file:///secret', '//evil.example', '/relative', 'HTTPS://example.com']) {
    const html = render(`[<unsafe> & label](${url})`);
    assert.match(html, /href="#"/);
    assert.doesNotMatch(html, /href="(?:javascript|data|vbscript|file|\/|HTTPS)/);
    assert.match(html, />&lt;unsafe&gt; &amp; label<span\b/);
  }
  const image = render('![<alt> & image](https://example.com/remote.png)');
  assert.doesNotMatch(image, /<img\b|<script\b/i);
  assert.match(image, /&lt;alt&gt; &amp; image/);
});

test('table header and formatted cells escape once while retaining table structure', () => {
  const html = render('| <head> & name | value |\n| --- | --- |\n| **<bold> & cell** | `<code> & cell` |');
  assert.match(html, /<table\b/);
  assert.match(html, /<th\b[^>]*>&lt;head&gt; &amp; name<\/th>/);
  assert.match(html, /<strong\b[^>]*>&lt;bold&gt; &amp; cell<\/strong>/);
  assert.match(html, /<code\b[^>]*>&lt;code&gt; &amp; cell<\/code>/);
  assert.equal((html.match(/<td\b/g) || []).length, 2);
  assert.doesNotMatch(html, /&amp;lt;/);
});

test('checked and unchecked tasks reach checkbox branch before the generic list', () => {
  const html = render('- [x] **<done> & ready**\n- [ ] `<todo> & next`');
  const inputs = html.match(/<input\b[^>]*>/g) || [];
  assert.equal(inputs.length, 2);
  for (const input of inputs) assert.match(input, /type="checkbox"[^>]*readOnly=""/);
  assert.match(inputs[0], /checked=""/);
  assert.doesNotMatch(inputs[1], /checked=/);
  assert.match(html, /line-through text-zinc-500/);
  assert.match(html, /<strong\b[^>]*>&lt;done&gt; &amp; ready<\/strong>/);
  assert.match(html, /<code\b[^>]*>&lt;todo&gt; &amp; next<\/code>/);
  assert.doesNotMatch(html, /•|\[x\]|\[ \]|&amp;lt;/);
});

test('plain dash/star lists and non-task bracket text remain ordinary lists', () => {
  const html = render('- <plain> & one\n* **<star> & two**\n- [x]not a task\n- [other] text');
  assert.equal((html.match(/•/g) || []).length, 4);
  assert.doesNotMatch(html, /<input\b|&amp;lt;/);
  assert.match(html, /&lt;plain&gt; &amp; one/);
  assert.match(html, /<strong\b[^>]*>&lt;star&gt; &amp; two<\/strong>/);
  assert.match(html, /\[x\]not a task/);
});

test('headings, quotes, separators, unmatched inline syntax and empty content still render', () => {
  const html = render('# <one> &\n## <two> &\n### <three> &\n> <quote> &\n---\n\n`unclosed [literal *');
  for (const [tag, text] of [['h1', 'one'], ['h2', 'two'], ['h3', 'three'], ['blockquote', 'quote']]) {
    assert.match(html, new RegExp(`<${tag}\\b[^>]*>&lt;${text}&gt; &amp;</${tag}>`));
  }
  assert.match(html, /<hr\b/);
  assert.match(html, /`unclosed \[literal \*/);
  assert.match(render(''), /^<div class="safe-markdown select-text "><div class="h-2"><\/div><\/div>$/);
});

test('SSR renderproof combines task, code, report table and inert untrusted content', () => {
  const html = render('# Review <T> & code\n- [x] **done <T>**\n- [ ] next\n```ts\nif (a < b && b > 0) {}\n```\n| Symbol | Value |\n| --- | --- |\n| `<T>` | <script>bad</script> |\n[help](https://example.com/?a=1&b=2)');
  assert.equal((html.match(/<input\b/g) || []).length, 2);
  assert.match(html, /<h1\b[^>]*>Review &lt;T&gt; &amp; code<\/h1>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /<script\b|&amp;lt;|&amp;gt;/);
});
