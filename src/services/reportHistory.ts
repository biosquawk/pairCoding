import type * as Wire from '../shared/protocol';
import type { SessionReport } from '../types/paircoach';

export type ReportSummary = Pick<Wire.Report, 'reportId' | 'sessionId' | 'status' | 'reason' | 'sourceWorkspaceVersion' | 'snapshotId' | 'generatedAt'>;
export interface ReportHistorySource {
  listReports(): Promise<ReportSummary[]>;
  readReport(sessionId: string): Promise<SessionReport>;
}
