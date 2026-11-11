/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface SafeMarkdownProps {
  content: string;
  className?: string;
}

/**
 * XSS-safe Markdown renderer without external images or arbitrary script execution.
 */
export const SafeMarkdown: React.FC<SafeMarkdownProps> = ({ content, className = '' }) => {
  // Parse markdown line by line into structured safe blocks
  const renderFormattedText = (text: string): React.ReactNode => {
    // Parse bold `**text**`, inline code `` `code` ``, links `[label](url)`
    const parts: React.ReactNode[] = [];
    // These strings are React text children, not HTML. React escapes them once.
    let remaining = text;
    let keyIdx = 0;

    while (remaining.length > 0) {
      // Check inline code
      const codeMatch = remaining.match(/^`([^`]+)`/);
      if (codeMatch) {
        parts.push(
          <code key={`code-${keyIdx++}`} className="px-1.5 py-0.5 rounded bg-zinc-800 text-amber-300 font-mono text-xs">
            {codeMatch[1]}
          </code>
        );
        remaining = remaining.substring(codeMatch[0].length);
        continue;
      }

      // Check bold
      const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
      if (boldMatch) {
        parts.push(
          <strong key={`bold-${keyIdx++}`} className="font-semibold text-zinc-100">
            {boldMatch[1]}
          </strong>
        );
        remaining = remaining.substring(boldMatch[0].length);
        continue;
      }

      // Check italic
      const italicMatch = remaining.match(/^\*([^*]+)\*/);
      if (italicMatch) {
        parts.push(
          <em key={`italic-${keyIdx++}`} className="italic text-zinc-300">
            {italicMatch[1]}
          </em>
        );
        remaining = remaining.substring(italicMatch[0].length);
        continue;
      }

      // Check link [label](url)
      const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        const label = linkMatch[1];
        const href = linkMatch[2];
        const safeHref = href.startsWith('http://') || href.startsWith('https://') ? href : '#';
        parts.push(
          <a
            key={`link-${keyIdx++}`}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline inline-flex items-center gap-1"
          >
            {label}
            <span className="text-[10px] opacity-70">↗</span>
          </a>
        );
        remaining = remaining.substring(linkMatch[0].length);
        continue;
      }

      // Normal text chunk
      const nextSpecial = remaining.search(/[`*\[]/);
      if (nextSpecial === -1) {
        parts.push(remaining);
        break;
      } else if (nextSpecial === 0) {
        // Unmatched character, consume 1
        parts.push(remaining[0]);
        remaining = remaining.substring(1);
      } else {
        parts.push(remaining.substring(0, nextSpecial));
        remaining = remaining.substring(nextSpecial);
      }
    }

    return parts;
  };

  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeLang = '';
  let inTable = false;
  let tableRows: string[][] = [];

  const flushCodeBlock = (key: number) => {
    if (codeBlockContent.length > 0) {
      elements.push(
        <div key={`cb-${key}`} className="my-3 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950">
          {codeLang && (
            <div className="px-3 py-1 bg-zinc-900 border-b border-zinc-800 text-[11px] font-mono text-zinc-400 uppercase tracking-wider">
              {codeLang}
            </div>
          )}
          <pre className="p-3 text-xs font-mono text-zinc-200 overflow-x-auto leading-relaxed">
            {codeBlockContent.join('\n')}
          </pre>
        </div>
      );
      codeBlockContent = [];
      codeLang = '';
    }
  };

  const flushTable = (key: number) => {
    if (tableRows.length > 0) {
      const [header, , ...body] = tableRows;
      elements.push(
        <div key={`tbl-${key}`} className="my-3 overflow-x-auto border border-zinc-800 rounded-lg">
          <table className="min-w-full text-xs text-left">
            {header && (
              <thead className="bg-zinc-900 text-zinc-300 border-b border-zinc-800 font-medium">
                <tr>
                  {header.map((col, idx) => (
                    <th key={idx} className="px-3 py-2">
                      {col.trim()}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-zinc-800/60 bg-zinc-950/60 text-zinc-300">
              {body.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-zinc-900/40">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2">
                      {renderFormattedText(cell.trim())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableRows = [];
      inTable = false;
    }
  };

  lines.forEach((line, index) => {
    // Code blocks ```
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        flushCodeBlock(index);
      } else {
        if (inTable) flushTable(index);
        inCodeBlock = true;
        codeLang = line.replace('```', '').trim();
      }
      return;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      return;
    }

    // Markdown Table
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      inTable = true;
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|');
      tableRows.push(cells);
      return;
    } else if (inTable) {
      flushTable(index);
    }

    // Horizontal rule
    if (line.trim() === '---' || line.trim() === '***') {
      elements.push(<hr key={index} className="my-4 border-zinc-800" />);
      return;
    }

    // Headings
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={index} className="text-xl font-bold text-zinc-100 mt-4 mb-2">
          {renderFormattedText(line.replace('# ', ''))}
        </h1>
      );
      return;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={index} className="text-base font-semibold text-zinc-100 mt-3 mb-1.5 border-b border-zinc-800/80 pb-1">
          {renderFormattedText(line.replace('## ', ''))}
        </h2>
      );
      return;
    }
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={index} className="text-sm font-semibold text-zinc-200 mt-2.5 mb-1">
          {renderFormattedText(line.replace('### ', ''))}
        </h3>
      );
      return;
    }

    // Checkbox lists must precede generic lists, which also match '- '.
    if (line.trim().startsWith('- [ ] ') || line.trim().startsWith('- [x] ')) {
      const isChecked = line.trim().startsWith('- [x] ');
      const text = line.trim().substring(6);
      elements.push(
        <div key={index} className="flex items-center gap-2 text-xs text-zinc-300 my-1 pl-2">
          <input
            type="checkbox"
            checked={isChecked}
            readOnly
            className="rounded border-zinc-700 bg-zinc-900 text-blue-500 focus:ring-0"
          />
          <span className={isChecked ? 'line-through text-zinc-500' : ''}>{renderFormattedText(text)}</span>
        </div>
      );
      return;
    }

    // Lists
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const text = line.trim().substring(2);
      elements.push(
        <div key={index} className="flex items-start gap-2 text-xs text-zinc-300 my-1 pl-2">
          <span className="text-blue-400 font-bold">•</span>
          <div>{renderFormattedText(text)}</div>
        </div>
      );
      return;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <blockquote key={index} className="pl-3 border-l-2 border-amber-500/80 text-zinc-300 italic text-xs my-2">
          {renderFormattedText(line.replace('> ', ''))}
        </blockquote>
      );
      return;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={index} className="h-2" />);
      return;
    }

    // Paragraph
    elements.push(
      <p key={index} className="text-xs text-zinc-300 leading-relaxed my-1">
        {renderFormattedText(line)}
      </p>
    );
  });

  if (inCodeBlock) flushCodeBlock(9999);
  if (inTable) flushTable(9999);

  return <div className={`safe-markdown select-text ${className}`}>{elements}</div>;
};
