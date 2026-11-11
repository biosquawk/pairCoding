/** Safe bounded messages; never interpolate a model response or context into ERROR. */
export class CoachResponseRejected extends Error {
  readonly safeMessage: string;
  constructor(reason: 'CAPABILITY' | 'EVIDENCE' | 'MUTE') {
    super('COACH_RESPONSE_REJECTED');
    this.safeMessage = {
      CAPABILITY: 'Ta propozycja trenera jest niedostępna; zachowano pracę.',
      EVIDENCE: 'Podpowiedź odrzucono: zawiera nieznany identyfikator dowodu; zachowano pracę.',
      MUTE: 'Wyciszenie odrzucono: wymaga aktualnej, bezpośredniej prośby użytkownika; zachowano pracę.',
    }[reason];
  }
}

// Intentionally a small command grammar, NOT semantic intent inference. Only complete
// independent prose clauses count. Removed data leaves a marker, never joins a command.
export function hasDirectMuteRequest(text: string): boolean {
  if (text.length > 4000) return false;
  let fence: { character: string; length: number } | null = null;
  let dataBlock = false;
  const lines: string[] = [];
  for (const line of text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' [DATA] ').split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (fence.character === marker[1][0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (/[:：]\s*$/.test(line) && /przykład|cytat|(?:w|z) plik|kod|instrukcj|napis|treść|poleceni|example|quote|file|json|xml/iu.test(line)) dataBlock = true;
    // Do not reclassify a later line of a pasted data block as human prose.
    if (/[<>{}\[\]=;]/.test(line) || /^\s*(?:>|#|\/\/)/.test(line)) dataBlock = true;
    if (dataBlock || fence || /^\s*(?:>|#|\/\/)/.test(line) || /^(?: {4}|\t)/.test(line) || /[<>{}\[\]=;]/.test(line)) continue;
    // Quotes may span lines; process together below. A backtick, including an
    // unmatched delimiter, blocks that span rather than exposing inline code.
    lines.push(line);
  }
  const prose = maskQuotedData(lines.join('\n'));
  const duration = '(?:\\s+(?:na|przez)\\s+(?:(?:jedn[ąa]|1)\\s+)?(?:chwil[ęe]|minut[ęe]|sekund[ęe]|(?:[1-9][0-9]{0,3}|dwie|trzy|pięć)\\s+(?:minuty|minut|sekundy|sekund)))?';
  const request = '(?:nie\\s+przerywaj(?:\\s+mi)?|nie\\s+podpowiadaj(?:\\s+mi)?|wycisz(?:\\s+(?:trenera|się|sie))?|zrób\\s+przerwę|przerwa|pauza|mute|stop\\s+interrupting|take\\s+a\\s+break)';
  const direct = new RegExp('^(?:prosz[ęe][, ]+)?' + request + duration + '$', 'iu');
  const alone = /^(?:daj mi chwil[ęe],? chcę (?:chwilę )?popracować sam(?:a)?|chcę chwilę popracować sam(?:a)?(?:,? wycisz trenera)?)$/iu;
  return prose.split(/[\n.!?]+/).some(clause => {
    const candidate = clause.trim();
    return direct.test(candidate) || alone.test(candidate);
  });
}

/** Exact inline backtick runs and escaped/multiline quotations remain data. */
function maskQuotedData(text: string): string {
  const pairs: Record<string, string> = {'"':'"', "'":"'", '„':'”', '“':'”', '«':'»', '‘':'’'};
  let safe = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '`') {
      let count = 1;
      while (text[i + count] === '`') count++;
      const delimiter = '`'.repeat(count);
      let end = text.indexOf(delimiter, i + count);
      while (end >= 0 && (text[end - 1] === '`' || text[end + count] === '`')) end = text.indexOf(delimiter, end + count);
      safe += ' [DATA] ';
      i = end < 0 ? text.length : end + count;
    } else if (pairs[text[i]]) {
      const close = pairs[text[i]];
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end++] === close) break;
      }
      safe += ' [DATA] '; i = end;
    } else safe += text[i++];
  }
  return safe;
}
