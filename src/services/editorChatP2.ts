export type EditorChatSenderP2 = (text: string) => boolean | void | Promise<boolean | void>;

/** Shared by the real form and narrow developer tests; guard is synchronous, before await. */
export class EditorChatSubmissionP2 {
  private pending = false;
  async submit(options: {
    text: string;
    revision: number;
    currentRevision: () => number;
    send: EditorChatSenderP2;
    clear: () => void;
    error: (message: string | null) => void;
    busy: (pending: boolean) => void;
  }): Promise<boolean> {
    if (this.pending || !options.text.trim()) return false;
    this.pending = true; options.busy(true); options.error(null);
    try {
      const result = await options.send(options.text.trim());
      if (result === false) throw new Error('Nie wysłano pytania. Tekst zachowano; sprawdź połączenie i kontekst edytora, a następnie spróbuj ponownie.');
      if (options.currentRevision() === options.revision) options.clear();
      return true;
    } catch (error) {
      options.error(error instanceof Error ? error.message : 'Nie wysłano pytania. Tekst zachowano.');
      return false;
    } finally { this.pending = false; options.busy(false); }
  }
}
