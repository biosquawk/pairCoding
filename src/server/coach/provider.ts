import type { CoachContext } from './context';
import { COACH_DECISION_SCHEMA } from './schema';
import { COACH_SYSTEM_PROMPT } from './prompt';

export interface CoachProvider {
  readonly name: string;
  readonly mode?: 'GEMINI' | 'LOCAL_FALLBACK' | 'INJECTED';
  decide(context: Readonly<CoachContext>, signal: AbortSignal): Promise<unknown>;
}

/** Deliberately silent; never presented as a successful real AI response. */
export class LocalFallbackProvider implements CoachProvider {
  readonly name = 'LOCAL_FALLBACK_NO_GEMINI_KEY';
  readonly mode = 'LOCAL_FALLBACK' as const;
  async decide(): Promise<unknown> {
    return { kind: 'SILENT', reason: 'Gemini API key missing; local fallback does not analyze code.' };
  }
}

export class GeminiCoachProvider implements CoachProvider {
  readonly name = 'GEMINI';
  readonly mode = 'GEMINI' as const;
  constructor(private readonly apiKey: string, private readonly model = process.env.GEMINI_MODEL || 'gemini-2.5-flash') {}
  async decide(context: Readonly<CoachContext>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    // Loaded only on the server and only when a configured, consented request occurs.
    const { GoogleGenAI } = await import('@google/genai');
    signal.throwIfAborted();
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const response = await ai.models.generateContent({
      model: this.model,
      contents: JSON.stringify(context),
      config: {
        systemInstruction: COACH_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseJsonSchema: COACH_DECISION_SCHEMA,
        abortSignal: signal,
      },
    });
    signal.throwIfAborted();
    if (!response.text) throw new Error('COACH_EMPTY_RESPONSE');
    return response.text;
  }
}

export function defaultCoachProvider(): CoachProvider {
  return process.env.GEMINI_API_KEY ? new GeminiCoachProvider(process.env.GEMINI_API_KEY) : new LocalFallbackProvider();
}
