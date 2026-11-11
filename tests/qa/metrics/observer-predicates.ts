/** Pure filters shared by the real browser observer and focused negative controls. */
export function createMetricPredicates() {
  return {
    baseline: (s: any) => Boolean(s && s.native && s.inputCount === 1 && s.connected && s.visible && s.loaded
      && s.activePath === 'main.py' && s.mode === 'python' && s.owner === 'COACH'
      && s.autocomplete === 'none' && !s.activeDescendant),
    pair: (keys: any[]) => Boolean(keys.length === 2 && keys.every(k => k.key === 'Escape' && k.isTrusted && !k.repeat)
      && keys[1].at - keys[0].at > 0 && keys[1].at - keys[0].at <= 400),
    ready: (base: any, s: any, validBase: boolean, validPair: boolean, veto: any) => ({
      validBase, validPair, realVeto: Boolean(veto?.messageId && veto?.sessionId),
      sameInput: Boolean(base && s && s.inputId === base.inputId && s.hostId === base.hostId && s.panelId === base.panelId),
      native: Boolean(s?.native && s.inputCount === 1), connected: Boolean(s?.connected), visible: Boolean(s?.visible),
      loaded: Boolean(s?.loaded && s.mode === 'python'), activePath: s?.activePath === 'main.py',
      student: s?.owner === 'STUDENT', writableSignal: s?.autocomplete === 'both', noSuggestion: !s?.activeDescendant,
    }),
    vetoAck: (v: any, a: any, c: any) => ({
      replyTo: Boolean(v && a && a.replyTo === v.messageId), status: a?.status === 'OK', error: a?.error === null,
      session: Boolean(v?.sessionId && a?.sessionId === v.sessionId && c?.sessionId === v.sessionId),
      connection: Boolean(v && a?.connection === v.connection && c?.connection === v.connection),
      epoch: Boolean(Number.isInteger(v?.controlEpoch) && a?.controlEpoch === v.controlEpoch + 1
        && c?.controlEpoch === a.controlEpoch),
      owner: c?.writeOwner === 'STUDENT' && c?.interventionId === null,
      order: Boolean(v && a && c && a.at >= v.at && c.at >= v.at && c.at <= a.at
        && Number.isInteger(c.seq) && c.seq > v.lastServerSeq && a.seq > c.seq),
    }),
    hint: (p: any) => Boolean(p && typeof p.id === 'string' && p.id.length && p.path === 'main.py'
      && typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 400
      && ['POSITIVE', 'NEUTRAL', 'WARNING'].includes(p.severity)
      && Number.isInteger(p.documentVersion) && p.documentVersion > 0
      && Array.isArray(p.evidenceIds) && p.evidenceIds.every((id: any) => typeof id === 'string' && id.length > 0)
      && (p.range === null || (p.range && ['startLine','startColumn','endLine','endColumn'].every(key =>
        Number.isInteger(p.range[key]) && p.range[key] > 0)
        && (p.range.endLine > p.range.startLine || (p.range.endLine === p.range.startLine && p.range.endColumn >= p.range.startColumn))))),
  };
}
